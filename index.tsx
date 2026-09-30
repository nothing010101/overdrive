"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { formatGameAmount } from "@rarefriends/friendsdk/ui";
import { maximumPrize, type GameSnapshot, type GamePlay } from "@rarefriends/friendsdk/game";
import { createFriendReader, spriteFrame } from "@rarefriends/friendsdk/sprites";
import { createFriendSoundKit, type FriendSoundKit, type FriendSoundCue } from "@rarefriends/friendsdk/sounds";
import "@rarefriends/friendsdk/frame.css";
import "./style.css";

const W = 960, H = 640, RUN = 75;
type Face = "left" | "right" | "up" | "down";
type Up = "rate" | "multi" | "speed" | "magnet" | "pierce" | "nova" | "repair";
type E = { x: number; y: number; vx: number; vy: number; hp: number; r: number; k: number; life: number; c: string; s: number };
type Sprites = Awaited<ReturnType<ReturnType<typeof createFriendReader>["read"]>>;
type Summary = { score: number; kills: number; time: number; level: number; cleared: boolean };
type Hooks = { paused: () => boolean; reduced: () => boolean; onLevel: (choices: Up[]) => void; onEnd: (summary: Summary) => void; cue: (cue: FriendSoundCue) => void };
type Menu = "odds" | "inventory" | "settings" | null;
type Phase = "menu" | "play" | "levelup" | "chest" | "reveal";

const UPS: Record<Up, [string, string]> = {
  rate: ["Overclock", "Fire 25% faster"],
  multi: ["Split shot", "+1 projectile per volley"],
  speed: ["Slipstream", "Move 15% faster"],
  magnet: ["Magnet", "Pull shards from further away"],
  pierce: ["Piercing", "Shots pass through one more foe"],
  nova: ["Pulse nova", "Rings of energy blast nearby foes"],
  repair: ["Patch", "Restore 40 HP"],
};
const rf = (value: bigint) => `${formatGameAmount(value, 18)} RF`;
const rankOf = (score: number) => (score >= 2000 ? "S" : score >= 1300 ? "A" : score >= 700 ? "B" : "C");

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function engine(canvas: HTMLCanvasElement, readSprites: () => Sprites | null, seed: number, hooks: Hooks) {
  const ctx = canvas.getContext("2d")!;
  const rnd = seeded(seed);
  const keys = new Set<string>();
  const ptr = { x: 0, y: 0, on: false };
  const p = { x: W / 2, y: H / 2, hp: 100, face: "down" as Face, walk: false, inv: 0, fire: 0, nova: 2, xp: 0, need: 5, lvl: 1, rate: 0.5, multi: 1, speed: 215, magnet: 80, pierce: 0, novaLv: 0 };
  const enemies: E[] = [], shots: E[] = [], shards: E[] = [], parts: E[] = [];
  const rings: { x: number; y: number; r: number; max: number }[] = [];
  const hits = new WeakMap<E, Set<E>>();
  const cache = new Map<string, HTMLCanvasElement>();
  let t = 0, kills = 0, spawn = 0.6, shake = 0, flash = 0, waiting = false, over = false, last = 0, raf = 0;
  const vignette = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.85);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,.72)");
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const sprite = (face: Face, walk: boolean, index: number) => {
    const key = `${face}${walk}${index}`;
    let c = cache.get(key);
    // Artwork arrives asynchronously; re-check every frame so a slow sprite read
    // upgrades the placeholder to the real Friend instead of freezing it out.
    const sprites = c ? null : readSprites();
    if (!c && sprites) {
      c = document.createElement("canvas"); c.width = 16; c.height = 16;
      const g = c.getContext("2d")!; g.fillStyle = "#fff";
      let rows: readonly string[] = [];
      try { rows = spriteFrame(sprites, face, walk, index, face === "left" ? "left" : "right").frame.rows; }
      catch { rows = spriteFrame(sprites, "right", false, 0, "right").frame.rows; }
      rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === "#") g.fillRect(x, y, 1, 1); }));
      cache.set(key, c);
    }
    return c;
  };

  const burst = (x: number, y: number, n: number, c: string, speed: number) => {
    const count = hooks.reduced() ? Math.ceil(n / 3) : n;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.7);
      parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, hp: 0, r: 1 + Math.random() * 2.4, k: 0, life: 0.35 + Math.random() * 0.4, c, s: 0 });
    }
  };

  const spawnEnemy = () => {
    const side = Math.floor(rnd() * 4), u = rnd(), roll = rnd();
    const x = side === 0 ? -24 : side === 1 ? W + 24 : u * W, y = side === 2 ? -24 : side === 3 ? H + 24 : u * H;
    const k = t > 20 && roll < 0.14 ? 2 : t > 10 && roll < 0.42 ? 1 : 0;
    const hp = k === 2 ? 12 + Math.floor(t / 5) : 2 + Math.floor(t / (k ? 30 : 25));
    const s = k === 2 ? 48 : k === 1 ? 135 : 68 + t * 0.6;
    enemies.push({ x, y, vx: 0, vy: 0, hp, r: k === 2 ? 20 : k === 1 ? 9 : 11, k, life: 0, c: k === 2 ? "#b48cff" : k === 1 ? "#ffb454" : "#ff5c8a", s });
  };

  const finish = (cleared: boolean) => {
    over = true;
    const time = Math.min(t, RUN);
    hooks.onEnd({ score: kills * 10 + Math.floor(time) * 5 + p.lvl * 25 + (cleared ? 300 : 0), kills, time, level: p.lvl, cleared });
  };

  const levelUp = () => {
    p.xp -= p.need; p.lvl++; p.need = Math.round(p.need * 1.32 + 2);
    const pool = (Object.keys(UPS) as Up[]).slice();
    const choices: Up[] = [];
    while (choices.length < 3) choices.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    waiting = true; hooks.cue("reward"); hooks.onLevel(choices);
  };

  const kill = (e: E) => {
    kills++;
    const drops = e.k === 2 ? 3 : 1;
    for (let i = 0; i < drops; i++) shards.push({ x: e.x + (Math.random() - 0.5) * 16, y: e.y + (Math.random() - 0.5) * 16, vx: 0, vy: 0, hp: 0, r: 4, k: 0, life: 0, c: "#5ee7d0", s: 0 });
    burst(e.x, e.y, e.k === 2 ? 26 : 12, e.c, 240);
    shake = Math.min(shake + (e.k === 2 ? 7 : 1.6), 12);
  };

  const update = (dt: number) => {
    t += dt;
    let dx = 0, dy = 0;
    if (keys.has("a") || keys.has("arrowleft")) dx -= 1;
    if (keys.has("d") || keys.has("arrowright")) dx += 1;
    if (keys.has("w") || keys.has("arrowup")) dy -= 1;
    if (keys.has("s") || keys.has("arrowdown")) dy += 1;
    if (ptr.on) { const ax = ptr.x - p.x, ay = ptr.y - p.y, d = Math.hypot(ax, ay); if (d > 14) { dx = ax / d; dy = ay / d; } }
    const m = Math.hypot(dx, dy);
    p.walk = m > 0;
    if (m > 0) {
      dx /= m; dy /= m;
      p.x = clamp(p.x + dx * p.speed * dt, 24, W - 24); p.y = clamp(p.y + dy * p.speed * dt, 40, H - 24);
      p.face = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
    }
    p.inv = Math.max(0, p.inv - dt); flash = Math.max(0, flash - dt);
    spawn -= dt;
    if (spawn <= 0) { spawn = Math.max(0.2, 0.95 - t * 0.0105); for (let i = 0; i < (t > 38 ? 2 : 1); i++) spawnEnemy(); }
    p.fire -= dt;
    if (p.fire <= 0 && enemies.length) {
      let best: E | null = null, bd = 420;
      for (const e of enemies) { const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < bd) { bd = d; best = e; } }
      if (best) {
        p.fire = p.rate;
        const base = Math.atan2(best.y - p.y, best.x - p.x);
        for (let i = 0; i < p.multi; i++) {
          const a = base + (i - (p.multi - 1) / 2) * 0.17;
          shots.push({ x: p.x, y: p.y, vx: Math.cos(a) * 560, vy: Math.sin(a) * 560, hp: p.pierce, r: 4, k: 0, life: 0.9, c: "#fff2c4", s: 0 });
        }
      }
    }
    if (p.novaLv > 0) {
      p.nova -= dt;
      if (p.nova <= 0) {
        p.nova = Math.max(2.4, 4.6 - p.novaLv * 0.45);
        const max = 100 + p.novaLv * 32;
        rings.push({ x: p.x, y: p.y, r: 0, max });
        for (const e of enemies) if (Math.hypot(e.x - p.x, e.y - p.y) < max + e.r) e.hp -= 2 * p.novaLv;
      }
    }
    for (const r of rings) r.r += (r.max - r.r) * Math.min(1, dt * 7) + dt * 40;
    for (let i = rings.length - 1; i >= 0; i--) if (rings[i].r > rings[i].max * 0.98) rings.splice(i, 1);
    for (const s of shots) {
      s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt;
      for (const e of enemies) {
        if (e.hp <= 0 || Math.hypot(e.x - s.x, e.y - s.y) > e.r + s.r) continue;
        const seen = hits.get(s) ?? new Set<E>();
        if (seen.has(e)) continue;
        seen.add(e); hits.set(s, seen);
        e.hp -= 1; e.vx += s.vx * 0.05; e.vy += s.vy * 0.05;
        burst(s.x, s.y, 4, "#bffcf2", 160);
        if (s.hp-- <= 0) { s.life = 0; break; }
      }
    }
    for (const e of enemies) {
      const ax = p.x - e.x, ay = p.y - e.y, d = Math.hypot(ax, ay) || 1;
      e.vx += (ax / d * e.s - e.vx) * Math.min(1, dt * 5); e.vy += (ay / d * e.s - e.vy) * Math.min(1, dt * 5);
      e.x += e.vx * dt; e.y += e.vy * dt;
      if (p.inv <= 0 && d < e.r + 13) {
        p.hp -= e.k === 2 ? 16 : 9; p.inv = 0.7; flash = 0.25; shake = Math.min(shake + 8, 14);
        burst(p.x, p.y, 18, "#ff6b7a", 260);
      }
    }
    for (let i = enemies.length - 1; i >= 0; i--) if (enemies[i].hp <= 0) { kill(enemies[i]); enemies.splice(i, 1); }
    for (let i = shots.length - 1; i >= 0; i--) if (shots[i].life <= 0) shots.splice(i, 1);
    for (let i = shards.length - 1; i >= 0; i--) {
      const s = shards[i], ax = p.x - s.x, ay = p.y - s.y, d = Math.hypot(ax, ay) || 1;
      if (d < p.magnet) { s.x += ax / d * 420 * dt; s.y += ay / d * 420 * dt; }
      if (d < 18) { shards.splice(i, 1); p.xp++; }
    }
    for (const q of parts) { q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.94; q.vy *= 0.94; q.life -= dt; }
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].life <= 0) parts.splice(i, 1);
    if (p.xp >= p.need && !waiting) levelUp();
    if (p.hp <= 0) finish(false);
    else if (t >= RUN) finish(true);
  };

  const poly = (x: number, y: number, r: number, n: number, rot: number) => {
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const a = rot + (i / n) * Math.PI * 2; ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); }
    ctx.closePath();
  };

  const draw = (now: number) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#07080c"; ctx.fillRect(0, 0, W, H);
    const sh = hooks.reduced() ? 0 : shake;
    ctx.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
    ctx.strokeStyle = "rgba(94,231,208,.07)"; ctx.lineWidth = 1;
    const ox = -(p.x * 0.25) % 48, oy = -(p.y * 0.25) % 48;
    ctx.beginPath();
    for (let x = ox; x < W; x += 48) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = oy; y < H; y += 48) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.strokeStyle = "rgba(216,178,106,.35)"; ctx.lineWidth = 2; ctx.strokeRect(10, 10, W - 20, H - 20);
    ctx.globalCompositeOperation = "lighter";
    for (const s of shards) { ctx.fillStyle = "#5ee7d0"; ctx.shadowColor = "#5ee7d0"; ctx.shadowBlur = 12; poly(s.x, s.y, 5 + Math.sin(now / 160 + s.x) * 1.2, 4, Math.PI / 4); ctx.fill(); }
    ctx.shadowBlur = 0;
    for (const r of rings) { ctx.strokeStyle = `rgba(216,178,106,${0.8 * (1 - r.r / r.max)})`; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2); ctx.stroke(); }
    for (const e of enemies) {
      ctx.fillStyle = e.c; ctx.shadowColor = e.c; ctx.shadowBlur = 16;
      const rot = e.k === 1 ? Math.atan2(e.vy, e.vx) : now / 600;
      poly(e.x, e.y, e.r, e.k === 2 ? 6 : e.k === 1 ? 3 : 4, rot); ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = "#07080c"; ctx.shadowBlur = 0; ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 0.32, 0, Math.PI * 2); ctx.fill();
    }
    for (const s of shots) { ctx.fillStyle = s.c; ctx.shadowColor = "#fff2c4"; ctx.shadowBlur = 14; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill(); }
    for (const q of parts) { ctx.globalAlpha = Math.max(0, q.life * 2); ctx.fillStyle = q.c; ctx.fillRect(q.x, q.y, q.r, q.r); }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = "source-over";
    const frame = sprite(p.face, p.walk, p.walk ? Math.floor(now / 110) % 8 : 0);
    const blink = p.inv > 0 && Math.floor(now / 70) % 2 === 0;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.beginPath(); ctx.ellipse(p.x, p.y + 26, 22, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = blink ? 0.35 : 1; ctx.shadowColor = flash > 0 ? "#ff6b7a" : "#5ee7d0"; ctx.shadowBlur = 20;
    if (frame) ctx.drawImage(frame, p.x - 32, p.y - 40, 64, 64);
    else { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(p.x, p.y - 8, 16, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = vignette; ctx.fillRect(0, 0, W, H);
    if (flash > 0) { ctx.fillStyle = `rgba(255,60,80,${flash * 0.6})`; ctx.fillRect(0, 0, W, H); }
    ctx.fillStyle = "rgba(238,242,247,.14)"; ctx.fillRect(0, 0, W, 6);
    ctx.fillStyle = "#5ee7d0"; ctx.fillRect(0, 0, W * Math.min(1, p.xp / p.need), 6);
    ctx.fillStyle = "rgba(10,12,18,.7)"; ctx.fillRect(22, 22, 264, 22);
    ctx.fillStyle = p.hp > 35 ? "#d8b26a" : "#ff6b7a"; ctx.fillRect(26, 26, 256 * Math.max(0, p.hp) / 100, 14);
    const rem = Math.max(0, Math.ceil(RUN - t));
    ctx.fillStyle = "#eef2f7"; ctx.textBaseline = "top";
    ctx.textAlign = "center"; ctx.font = "700 40px ui-sans-serif,system-ui,sans-serif";
    ctx.fillText(`${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, "0")}`, W / 2, 14);
    ctx.textAlign = "right"; ctx.font = "600 24px ui-sans-serif,system-ui,sans-serif";
    ctx.fillText(`LV ${p.lvl}  ·  ${kills} kills`, W - 24, 20);
  };

  const loop = (now: number) => {
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0);
    last = now;
    if (!over && !waiting && !hooks.paused() && !document.hidden) update(dt);
    shake *= 0.86;
    draw(now);
    if (!over) raf = requestAnimationFrame(loop); else draw(now);
  };

  const down = (e: KeyboardEvent) => { const k = e.key.toLowerCase(); if (k.startsWith("arrow") || k === " ") e.preventDefault(); keys.add(k); };
  const up = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
  const move = (e: PointerEvent) => { const b = canvas.getBoundingClientRect(); ptr.x = (e.clientX - b.left) * W / b.width; ptr.y = (e.clientY - b.top) * H / b.height; };
  const press = (e: PointerEvent) => { ptr.on = true; move(e); canvas.setPointerCapture(e.pointerId); };
  const release = () => { ptr.on = false; };
  const blur = () => { keys.clear(); ptr.on = false; };
  window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", blur);
  canvas.addEventListener("pointerdown", press); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", release); canvas.addEventListener("pointercancel", release);
  raf = requestAnimationFrame(loop);

  return {
    pick(id: Up) {
      if (id === "rate") p.rate *= 0.8;
      else if (id === "multi") p.multi++;
      else if (id === "speed") p.speed *= 1.15;
      else if (id === "magnet") p.magnet += 70;
      else if (id === "pierce") p.pierce++;
      else if (id === "nova") p.novaLv++;
      else p.hp = Math.min(100, p.hp + 40);
      waiting = false;
    },
    stop() {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur);
      canvas.removeEventListener("pointerdown", press); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", release); canvas.removeEventListener("pointercancel", release);
    },
  };
}

export default function Overdrive({ friendId, client, paused }: GameComponentProps) {
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [phase, setPhase] = useState<Phase>("menu");
  const [result, setResult] = useState<GamePlay | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [choices, setChoices] = useState<Up[]>([]);
  const [runId, setRunId] = useState(0);
  const [best, setBest] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [muted, setMuted] = useState(true);
  const [reduced, setReduced] = useState(false);
  const [sprites, setSprites] = useState<Sprites | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const spritesRef = useRef<Sprites | null>(null);
  const core = useRef<ReturnType<typeof engine> | null>(null);
  const sound = useRef<FriendSoundKit | null>(null);
  const live = useRef({ paused, reduced });
  const locked = useRef(false);
  const epoch = useRef(0);
  live.current = { paused, reduced };
  spritesRef.current = sprites;
  const definition = client.definition;
  const day = useMemo(() => Math.floor(Date.now() / 86400000), []);

  useEffect(() => {
    const version = ++epoch.current;
    sound.current = createFriendSoundKit({ muted: true });
    setSnapshot(null); setMenu(null); setPhase("menu"); setResult(null); setError(""); setMessage(""); setBusy(false); setMuted(true); setSprites(null); locked.current = false;
    void client.read().then(value => { if (version === epoch.current) setSnapshot(value); })
      .catch(cause => { if (version === epoch.current) setError(cause instanceof Error ? cause.message : "Could not load the preview."); });
    void createFriendReader().read(friendId).then(value => { if (version === epoch.current) setSprites(value); }).catch(() => undefined);
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => { epoch.current++; core.current?.stop(); core.current = null; sound.current?.dispose(); sound.current = null; preference.removeEventListener("change", update); };
  }, [client, friendId]);

  useEffect(() => {
    if (!runId || !canvas.current) return;
    const game = engine(canvas.current, () => spritesRef.current, day * 2654435761 + runId, {
      paused: () => live.current.paused,
      reduced: () => live.current.reduced,
      cue: cue => sound.current?.play(cue),
      onLevel: list => { setChoices(list); setPhase("levelup"); },
      onEnd: done => { setSummary(done); setBest(value => Math.max(value, done.score)); setPhase("chest"); },
    });
    core.current = game;
    return () => { game.stop(); core.current = null; };
  }, [runId]);

  const choose = (id: Up) => { core.current?.pick(id); setPhase("play"); };

  useEffect(() => {
    if (phase !== "levelup") return;
    const onKey = (event: KeyboardEvent) => { const i = Number(event.key) - 1; if (i >= 0 && i < choices.length) choose(choices[i]); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, choices]);

  async function act(work: () => Promise<void>, cue?: FriendSoundCue, after?: () => void) {
    if (locked.current || paused) return;
    const version = epoch.current;
    locked.current = true; setBusy(true); setError(""); setMessage(""); void sound.current?.unlock();
    try {
      await work();
      const value = await client.read();
      if (version === epoch.current) { setSnapshot(value); if (cue) sound.current?.play(cue); after?.(); }
    } catch (cause) {
      if (version === epoch.current) setError(cause instanceof Error ? cause.message : "The preview action failed.");
    } finally {
      if (version === epoch.current) { locked.current = false; setBusy(false); }
    }
  }

  const feedback = <p className="od-status" role={error ? "alert" : "status"}>{error || message || (busy ? "Waiting for preview confirmation…" : "Simulated RF and outcomes. Score and rank are cosmetic and never change odds.")}</p>;

  if (!snapshot) return (
    <div className="od-loading" role={error ? "alert" : "status"}>{error || "Booting Overdrive…"}
      {error && <button type="button" disabled={busy || paused} onClick={() => void act(async () => undefined)}>Retry</button>}
    </div>
  );
  if (snapshot.friendId !== friendId) return <p role="alert">This game session does not match the selected Friend.</p>;

  const maxPrize = maximumPrize(definition);
  const canBuy = snapshot.rfBalance >= definition.price && snapshot.freeStake >= maxPrize && snapshot.freeStake + definition.price >= maxPrize;
  const pending = snapshot.plays.find(item => item.outcomeId === null);
  const ready = snapshot.consumables > 0n || Boolean(pending);
  const outcomeIndex = result?.outcomeId ? result.outcomeId - 1 : -1;
  const outcome = outcomeIndex >= 0 ? definition.outcomes[outcomeIndex] : null;
  const count = snapshot.inventory.reduce((total, amount) => total + amount, 0n);
  const rank = summary ? rankOf(summary.score) : "C";
  const playing = phase === "play" || phase === "levelup";

  const openChest = () => act(async () => {
    const version = epoch.current;
    const opened = pending ?? (await client.play(1n))[0];
    const settled = await client.settle(opened.id);
    if (version === epoch.current) { setResult(settled); setPhase("reveal"); }
  }, "reveal-common");

  return (
    <section className={`od-game od-rank-${rank}`} aria-label={definition.name} aria-busy={busy}>
      {playing && (
        <div className="od-stage">
          <div className="od-stage-inner">
            <canvas ref={canvas} className="od-canvas" width={W} height={H} aria-label="Overdrive arena" />
          </div>
          {phase === "play" && <p className="od-hint">WASD / arrows / drag to move · auto-fire · collect shards</p>}
        </div>
      )}

      {phase === "levelup" && (
        <div className="od-overlay" role="dialog" aria-label="Choose an upgrade">
          <h2>Level up</h2>
          <div className="od-cards">
            {choices.map((id, index) => (
              <button type="button" key={id} className="od-card" onClick={() => choose(id)}>
                <kbd>{index + 1}</kbd><strong>{UPS[id][0]}</strong><span>{UPS[id][1]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {phase === "menu" && (
        <div className="od-screen" inert={Boolean(menu) || undefined}>
          <header className="od-top">
            <span className="od-chip">Preview · {rf(snapshot.rfBalance)} · {snapshot.consumables.toString()} tickets</span>
            <button type="button" onClick={() => !busy && setMenu("odds")}>Odds</button>
            <button type="button" onClick={() => !busy && setMenu("inventory")}>Vault · {count.toString()}</button>
            <button type="button" onClick={() => !busy && setMenu("settings")}>Settings</button>
          </header>
          <div className="od-hero">
            <small>Daily arena #{day % 10000} · same spawns for everyone</small>
            <h1>OVERDRIVE</h1>
            <p>75 seconds. Your Rare Friend holds the line against the glitch swarm. Survive, level up, then crack the cache.</p>
            {best > 0 && <p className="od-best">Best score this session · {best}</p>}
            {ready
              ? <button type="button" className="od-cta" disabled={busy || paused} onClick={() => { setSummary(null); setResult(null); setError(""); setMessage(""); setPhase("play"); setRunId(value => value + 1); }}>Start run</button>
              : <button type="button" className="od-cta" disabled={!canBuy || busy || paused} onClick={() => void act(() => client.buy(1n), "purchase", () => setMessage("One simulated Run Ticket added."))}>Buy Run Ticket · {rf(definition.price)}</button>}
            {!ready && !canBuy && <p className="od-best">{snapshot.rfBalance < definition.price ? "Not enough simulated RF." : "New tickets are paused until there is enough free backing."}</p>}
          </div>
          <footer className="od-foot">{feedback}</footer>
        </div>
      )}

      {phase === "chest" && summary && (
        <div className="od-screen od-center">
          <small>{summary.cleared ? "Arena cleared" : "Friend down"}</small>
          <div className="od-rank">{rank}</div>
          <p className="od-stats">{summary.score} pts · {summary.kills} kills · LV {summary.level} · {Math.floor(summary.time)}s</p>
          <button type="button" className="od-cta" disabled={busy || paused} onClick={() => void openChest()}>{pending ? "Finish opening" : "Open cache · uses 1 ticket"}</button>
          {feedback}
        </div>
      )}

      {phase === "reveal" && outcome && (
        <div className="od-screen od-center od-pop">
          <small>Rank {rank} cache · cosmetic glow</small>
          <h2>{outcome.name}</h2>
          <p className="od-stats">{rf(outcome.reward)} · {outcome.chanceBps / 100}% chance</p>
          <div className="od-actions">
            <button type="button" disabled={busy || paused} onClick={() => { setPhase("menu"); setResult(null); }}>Keep it</button>
            <button type="button" className="od-cta" disabled={busy || paused} onClick={() => void act(() => client.redeem(result!.outcomeId!, 1n), "reward", () => { setPhase("menu"); setResult(null); setMessage("Redeemed in the simulated ledger."); })}>Redeem · {rf(outcome.reward)}</button>
          </div>
          {feedback}
        </div>
      )}

      {menu && (
        <GameMenu title={menu === "odds" ? "Cache odds" : menu === "inventory" ? "Vault" : "Settings"} onClose={busy ? undefined : () => { setMenu(null); setError(""); }}>
          {menu === "odds" ? <>
            <p>One Run Ticket costs {rf(definition.price)} and is spent when you open the cache after a run. Score and rank only tint the reveal; they never change these odds.</p>
            <table className="od-table"><thead><tr><th>Cache</th><th>Chance</th><th>Value</th></tr></thead><tbody>
              {definition.outcomes.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.chanceBps / 100}%</td><td>{rf(item.reward)}</td></tr>)}
            </tbody></table>
            <p>Every ticket reserves {rf(maxPrize)}. Purchased tickets remain usable.</p>
          </> : menu === "inventory" ? <>
            <p>Kept caches retain their fixed value with no expiry.</p>
            {definition.outcomes.map((item, index) => (
              <div className="od-item" key={item.name}>
                <span><strong>{item.name}</strong><small>{snapshot.inventory[index].toString()} owned · {rf(item.reward)}</small></span>
                <button type="button" disabled={busy || paused || snapshot.inventory[index] === 0n} onClick={() => void act(() => client.redeem(index + 1, 1n), "reward")}>Redeem one</button>
              </div>
            ))}
          </> : <>
            <button type="button" aria-pressed={!muted} onClick={() => { const next = !muted; setMuted(next); sound.current?.setMuted(next); if (!next) void sound.current?.unlock(); }}>{muted ? "Sound off" : "Sound on"}</button>
            <label><input type="checkbox" checked={reduced} onChange={event => setReduced(event.target.checked)} /> Reduce motion</label>
            <p>All economy actions are simulated. Reloading resets this preview. Wallet connection and ownership verification are provided by the SDK.</p>
          </>}
          {feedback}
        </GameMenu>
      )}
    </section>
  );
}
