"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { formatGameAmount } from "@rarefriends/friendsdk/ui";
import { maximumPrize, RF, type GameSnapshot, type GamePlay } from "@rarefriends/friendsdk/game";
import { createFriendReader, spriteFrame } from "@rarefriends/friendsdk/sprites";
import { createFriendSoundKit, type FriendSoundKit, type FriendSoundCue } from "@rarefriends/friendsdk/sounds";
import "@rarefriends/friendsdk/frame.css";
import "./style.css";

const W = 960, H = 640, RUN = 75;
type Face = "left" | "right" | "up" | "down";
type Up = "rate" | "multi" | "speed" | "magnet" | "pierce" | "nova" | "repair";
type Weapon = "blaster" | "scatter" | "lance" | "orbiter";
type Perk = "hull" | "thruster" | "coil" | "core";
type E = { x: number; y: number; vx: number; vy: number; hp: number; r: number; k: number; life: number; c: string; s: number; hit: number; age: number; ph: number };
type Warn = { x: number; y: number; t: number; k: number };
type Sprites = Awaited<ReturnType<ReturnType<typeof createFriendReader>["read"]>>;
type Summary = { score: number; kills: number; time: number; level: number; cleared: boolean };
type Hooks = { paused: () => boolean; reduced: () => boolean; onLevel: (choices: Up[]) => void; onEnd: (summary: Summary) => void; cue: (cue: FriendSoundCue, volume?: number) => void };
type Menu = "odds" | "inventory" | "settings" | null;
type Phase = "menu" | "armory" | "pilot" | "play" | "levelup" | "chest" | "reveal";
type Loadout = { weapon: Weapon; perks: Record<Perk, number> };
type Stats = { runs: number; kills: number; best: number; bestRank: string; rfSpent: bigint; rfEarned: bigint; caches: bigint };

const UPS: Record<Up, [string, string]> = {
  rate: ["Overclock", "Fire 25% faster"],
  multi: ["Split shot", "+1 projectile per volley"],
  speed: ["Slipstream", "Move 15% faster"],
  magnet: ["Magnet", "Pull shards from further away"],
  pierce: ["Piercing", "Shots pass through one more foe"],
  nova: ["Pulse nova", "Rings of energy blast nearby foes"],
  repair: ["Patch", "Restore 40 HP"],
};

const WEAPONS: Record<Weapon, { name: string; blurb: string; price: bigint; rate: number; shots: number; spread: number; speed: number; pierce: number; orbs: number; tint: string }> = {
  blaster: { name: "Blaster", blurb: "Balanced single shot", price: 0n, rate: 0.42, shots: 1, spread: 0, speed: 560, pierce: 0, orbs: 0, tint: "#fff2c4" },
  scatter: { name: "Scatter", blurb: "Three pellets in a wide arc", price: 4n * RF, rate: 0.60, shots: 3, spread: 0.30, speed: 470, pierce: 0, orbs: 0, tint: "#ffd9a0" },
  lance: { name: "Lance", blurb: "Fast beam that pierces two foes", price: 5n * RF, rate: 0.80, shots: 1, spread: 0, speed: 900, pierce: 2, orbs: 0, tint: "#bffcf2" },
  orbiter: { name: "Orbiter", blurb: "Twin drones circle you and burn on contact", price: 7n * RF, rate: 0.50, shots: 1, spread: 0, speed: 520, pierce: 0, orbs: 2, tint: "#9ef7ff" },
};

const PERKS: Record<Perk, { name: string; blurb: string; price: bigint; max: number }> = {
  hull: { name: "Hull plating", blurb: "+25 max HP per level", price: 2n * RF, max: 4 },
  thruster: { name: "Thruster", blurb: "+8% move speed per level", price: 2n * RF, max: 4 },
  coil: { name: "Magnet coil", blurb: "+35 pickup range per level", price: 2n * RF, max: 4 },
  core: { name: "Power core", blurb: "+12% fire rate per level", price: 3n * RF, max: 4 },
};

const PHASES: readonly (readonly [number, string])[] = [[10, "PHASE 2 · DARTERS"], [20, "PHASE 3 · BRUTES"], [38, "PHASE 4 · SWARM"]];
const PERK_IDS = Object.keys(PERKS) as Perk[];
const WEAPON_IDS = Object.keys(WEAPONS) as Weapon[];
const emptyPerks = (): Record<Perk, number> => ({ hull: 0, thruster: 0, coil: 0, core: 0 });

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

function engine(canvas: HTMLCanvasElement, readSprites: () => Sprites | null, seed: number, loadout: Loadout, hooks: Hooks) {
  const ctx = canvas.getContext("2d")!;
  const rnd = seeded(seed);
  const weapon = WEAPONS[loadout.weapon];
  const keys = new Set<string>();
  const ptr = { x: 0, y: 0, on: false };
  const maxHp = 100 + loadout.perks.hull * 25;
  const p = { x: W / 2, y: H / 2, hp: maxHp, face: "down" as Face, walk: false, inv: 0, fire: 0, nova: 2, xp: 0, need: 5, lvl: 1,
    rate: weapon.rate / (1 + 0.12 * loadout.perks.core), multi: 1, speed: 215 * (1 + 0.08 * loadout.perks.thruster),
    magnet: 110 + loadout.perks.coil * 35, pierce: 0, novaLv: 0, aim: 0, flash: 0 };
  const enemies: E[] = [], shots: E[] = [], shards: E[] = [], parts: E[] = [];
  const rings: { x: number; y: number; r: number; max: number }[] = [];
  const warns: Warn[] = [];
  const hits = new WeakMap<E, Set<E>>();
  const orbHits = new WeakMap<E, number>();
  const cache = new Map<string, HTMLCanvasElement>();
  let t = 0, kills = 0, spawn = 0.6, shake = 0, flash = 0, waiting = false, over = false, last = 0, raf = 0;
  let warned = false, lowHp = false, lastShot = -1, lastKill = -1, banner = "", bannerT = 0, phaseIdx = 0;
  const vignette = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.85);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,.72)");
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const sprite = (face: Face, walk: boolean, index: number) => {
    const key = `${face}${walk}${index}`;
    let c = cache.get(key);
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
      parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, hp: 0, r: 1 + Math.random() * 2.4, k: 0, life: 0.35 + Math.random() * 0.4, c, s: 0, hit: 0, age: 0, ph: 0 });
    }
  };

  const kindOf = (roll: number) => (t > 20 && roll < 0.14 ? 2 : t > 10 && roll < 0.42 ? 1 : 0);

  const queueSpawn = () => {
    const side = Math.floor(rnd() * 4), u = rnd(), roll = rnd();
    const x = side === 0 ? -24 : side === 1 ? W + 24 : u * W, y = side === 2 ? -24 : side === 3 ? H + 24 : u * H;
    warns.push({ x, y, t: 0.55, k: kindOf(roll) });
  };

  const hatch = (w: Warn) => {
    const k = w.k;
    const hp = k === 2 ? 12 + Math.floor(t / 5) : 2 + Math.floor(t / (k ? 30 : 25));
    const s = k === 2 ? 48 : k === 1 ? 135 : 68 + t * 0.6;
    enemies.push({ x: w.x, y: w.y, vx: 0, vy: 0, hp, r: k === 2 ? 21 : k === 1 ? 10 : 13, k,
      life: 0, c: k === 2 ? "#b48cff" : k === 1 ? "#ffb454" : "#ff5c8a", s, hit: 0, age: 0, ph: Math.random() * 6.28 });
    burst(w.x, w.y, 8, k === 2 ? "#b48cff" : k === 1 ? "#ffb454" : "#ff5c8a", 150);
  };

  const finish = (cleared: boolean) => {
    over = true;
    const time = Math.min(t, RUN);
    hooks.cue(cleared ? "action-ready" : "impact");
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
    for (let i = 0; i < drops; i++) shards.push({ x: e.x + (Math.random() - 0.5) * 16, y: e.y + (Math.random() - 0.5) * 16, vx: 0, vy: 0, hp: 0, r: 4, k: 0, life: 0, c: "#5ee7d0", s: 0, hit: 0, age: 0, ph: Math.random() * 6.28 });
    burst(e.x, e.y, e.k === 2 ? 26 : 12, e.c, 240);
    shake = Math.min(shake + (e.k === 2 ? 7 : 1.6), 12);
    // Throttled so a swarm wipe does not turn into a wall of noise.
    if (t - lastKill > 0.07) { lastKill = t; hooks.cue("impact", 0.3); }
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
    p.flash = Math.max(0, p.flash - dt);
    bannerT = Math.max(0, bannerT - dt);
    while (phaseIdx < PHASES.length && t >= PHASES[phaseIdx][0]) {
      banner = PHASES[phaseIdx][1]; bannerT = 1.8; phaseIdx++;
      hooks.cue("anticipation");
    }
    spawn -= dt;
    if (spawn <= 0) { spawn = Math.max(0.2, 0.95 - t * 0.0105); for (let i = 0; i < (t > 38 ? 2 : 1); i++) queueSpawn(); }
    for (let i = warns.length - 1; i >= 0; i--) { warns[i].t -= dt; if (warns[i].t <= 0) { hatch(warns[i]); warns.splice(i, 1); } }

    // Tension cues, each fired once.
    if (!warned && RUN - t <= 10) { warned = true; hooks.cue("anticipation"); }
    if (!lowHp && p.hp <= maxHp * 0.3) { lowHp = true; hooks.cue("anticipation"); }

    p.fire -= dt;
    if (p.fire <= 0 && enemies.length) {
      let best: E | null = null, bd = 460;
      for (const e of enemies) { const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < bd) { bd = d; best = e; } }
      if (best) {
        p.fire = p.rate;
        const base = Math.atan2(best.y - p.y, best.x - p.x);
        p.aim = base; p.flash = 0.07;
        // A shot you can hear, at a rate that stays readable instead of buzzing.
        if (t - lastShot > 0.085) { lastShot = t; hooks.cue("select", 0.3); }
        const count = weapon.shots + p.multi - 1;
        const step = weapon.shots > 1 ? weapon.spread : 0.17;
        for (let i = 0; i < count; i++) {
          const a = base + (i - (count - 1) / 2) * step;
          shots.push({ x: p.x, y: p.y, vx: Math.cos(a) * weapon.speed, vy: Math.sin(a) * weapon.speed,
            hp: weapon.pierce + p.pierce, r: weapon.shots > 1 ? 3.4 : 4.4, k: 0, life: 0.9, c: weapon.tint, s: 0, hit: 0, age: 0, ph: 0 });
        }
      }
    }
    // Orbiter drones burn anything they sweep through.
    for (let i = 0; i < weapon.orbs; i++) {
      const a = t / 0.7 + i * Math.PI, ox = p.x + Math.cos(a) * 62, oy = p.y + Math.sin(a) * 62;
      for (const e of enemies) {
        if (Math.hypot(e.x - ox, e.y - oy) > e.r + 11) continue;
        if (t - (orbHits.get(e) ?? -9) < 0.4) continue;
        orbHits.set(e, t); e.hp -= 1; e.hit = 0.12; burst(ox, oy, 3, "#9ef7ff", 130);
      }
    }
    if (p.novaLv > 0) {
      p.nova -= dt;
      if (p.nova <= 0) {
        p.nova = Math.max(2.4, 4.6 - p.novaLv * 0.45);
        const max = 100 + p.novaLv * 32;
        rings.push({ x: p.x, y: p.y, r: 0, max });
        for (const e of enemies) if (Math.hypot(e.x - p.x, e.y - p.y) < max + e.r) { e.hp -= 2 * p.novaLv; e.hit = 0.12; }
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
        e.hp -= 1; e.hit = 0.12; e.vx += s.vx * 0.05; e.vy += s.vy * 0.05;
        burst(s.x, s.y, 4, "#bffcf2", 160);
        if (s.hp-- <= 0) { s.life = 0; break; }
      }
    }
    for (const e of enemies) {
      e.age += dt; e.hit = Math.max(0, e.hit - dt);
      const ax = p.x - e.x, ay = p.y - e.y, d = Math.hypot(ax, ay) || 1;
      e.vx += (ax / d * e.s - e.vx) * Math.min(1, dt * 5); e.vy += (ay / d * e.s - e.vy) * Math.min(1, dt * 5);
      e.x += e.vx * dt; e.y += e.vy * dt;
      if (p.inv <= 0 && d < e.r + 13) {
        p.hp -= e.k === 2 ? 16 : 9; p.inv = 0.7; flash = 0.25; shake = Math.min(shake + 8, 14);
        hooks.cue("impact");
        burst(p.x, p.y, 18, "#ff6b7a", 260);
      }
    }
    for (let i = enemies.length - 1; i >= 0; i--) if (enemies[i].hp <= 0) { kill(enemies[i]); enemies.splice(i, 1); }
    for (let i = shots.length - 1; i >= 0; i--) if (shots[i].life <= 0) shots.splice(i, 1);
    // Shards drift toward the Friend from anywhere, then snap in close.
    for (let i = shards.length - 1; i >= 0; i--) {
      const s = shards[i], ax = p.x - s.x, ay = p.y - s.y, d = Math.hypot(ax, ay) || 1;
      const pull = d < p.magnet ? 430 : 70;
      s.x += ax / d * pull * dt; s.y += ay / d * pull * dt;
      if (d < 20) { shards.splice(i, 1); p.xp++; }
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

  /**
   * Each foe is a drawn creature, not a bare polygon. The silhouette is filled dark
   * and rimmed in neon so it still reads as a creature at ~26px on a phone, and the
   * eyes are oversized and glowing because that is what sells "alive" at small sizes.
   */
  const drawFoe = (e: E, now: number) => {
    const hit = e.hit > 0;
    const line = hit ? "#ffffff" : e.c;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (e.k === 0) {
      // Crawler: pulsing body, six skittering legs, two glowing eyes.
      ctx.rotate(now / 900 + e.ph);
      const stretch = 1 + Math.sin(now / 150 + e.ph) * 0.09;
      ctx.beginPath(); ctx.ellipse(0, 0, e.r * stretch, e.r / stretch, 0, 0, Math.PI * 2);
      ctx.fillStyle = hit ? "#ffffff" : "#2b0d1b";
      ctx.fill();
      ctx.shadowColor = e.c; ctx.shadowBlur = 10;
      ctx.strokeStyle = line; ctx.lineWidth = 2.4; ctx.stroke();
      ctx.lineWidth = 2.2;
      for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
        const lx = -e.r * 0.62 + i * e.r * 0.62, ly = side * e.r * 0.66;
        const kick = Math.sin(now / 85 + i * 1.7 + (side > 0 ? 0.9 : 0)) * e.r * 0.42;
        ctx.beginPath(); ctx.moveTo(lx, ly * 0.5); ctx.lineTo(lx + kick, ly * 1.75); ctx.stroke();
      }
      ctx.shadowBlur = 9; ctx.fillStyle = hit ? "#ffffff" : "#fff1f6";
      for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(e.r * 0.3, side * e.r * 0.36, e.r * 0.23, 0, Math.PI * 2); ctx.fill(); }
      ctx.shadowBlur = 0; ctx.fillStyle = "#12040b";
      for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(e.r * 0.36, side * e.r * 0.36, e.r * 0.1, 0, Math.PI * 2); ctx.fill(); }
    } else if (e.k === 1) {
      // Darter: dark dart rimmed in neon, nose to velocity, fading motion tail.
      ctx.rotate(Math.atan2(e.vy, e.vx));
      ctx.strokeStyle = line; ctx.lineWidth = 2.4;
      for (let i = 1; i <= 3; i++) {
        ctx.globalAlpha = 0.55 - i * 0.14;
        ctx.beginPath(); ctx.moveTo(-e.r * (1 + i * 0.9), 0); ctx.lineTo(-e.r * (0.55 + i * 0.9), 0); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.moveTo(e.r * 1.9, 0); ctx.lineTo(-e.r * 0.9, e.r * 1.0); ctx.lineTo(-e.r * 0.25, 0); ctx.lineTo(-e.r * 0.9, -e.r * 1.0); ctx.closePath();
      ctx.fillStyle = hit ? "#ffffff" : "#2e1804"; ctx.fill();
      ctx.shadowColor = e.c; ctx.shadowBlur = 10; ctx.stroke();
      ctx.shadowBlur = 9; ctx.fillStyle = hit ? "#ffffff" : "#fff4e0";
      ctx.beginPath(); ctx.arc(e.r * 0.55, 0, e.r * 0.3, 0, Math.PI * 2); ctx.fill();
    } else {
      // Brute: armoured hexagon, rotating plates and a pulsing core.
      const spin = now / 1400 + e.ph;
      ctx.beginPath(); ctx.ellipse(0, 0, e.r, e.r * 0.94, 0, 0, Math.PI * 2);
      ctx.fillStyle = hit ? "#ffffff" : "#1d1436"; ctx.fill();
      ctx.shadowColor = e.c; ctx.shadowBlur = 12;
      ctx.strokeStyle = line; ctx.lineWidth = 3; ctx.stroke();
      ctx.shadowBlur = 0;
      for (let i = 0; i < 3; i++) {
        const a = spin + i * (Math.PI * 2 / 3);
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * e.r * 0.9, Math.sin(a) * e.r * 0.9);
        ctx.lineTo(Math.cos(a) * e.r * 1.42, Math.sin(a) * e.r * 1.42); ctx.stroke();
      }
      poly(0, 0, e.r * 0.62, 6, spin); ctx.lineWidth = 2; ctx.stroke();
      const pulse = 0.5 + Math.sin(now / 220 + e.ph) * 0.5;
      ctx.shadowColor = e.c; ctx.shadowBlur = 14;
      ctx.fillStyle = hit ? "#ffffff" : "#ffd9ff";
      ctx.beginPath(); ctx.arc(0, 0, e.r * (0.2 + pulse * 0.13), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  };

  const rr = (x: number, y: number, w: number, h: number, r: number) => {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  };

  /** Anything bought in the Armory is drawn on the Friend, so the loadout is visible in play. */
  const drawRigBehind = (now: number) => {
    const perks = loadout.perks;
    // Magnet coil: a dashed ring at the real pickup radius, so the upgrade is legible.
    if (perks.coil > 0) {
      ctx.save();
      ctx.globalAlpha = 0.13 + 0.05 * Math.sin(now / 420);
      ctx.strokeStyle = "#5ee7d0"; ctx.lineWidth = 1.5;
      ctx.setLineDash([7, 11]); ctx.lineDashOffset = -now / 35;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.magnet, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    // Thruster: nozzles below the Friend, with a soft teardrop exhaust that lengthens on the move.
    if (perks.thruster > 0) {
      const thrust = p.walk ? 1 : 0.3;
      ctx.save();
      for (const side of [-1, 1]) {
        const nx = p.x + side * 15, ny = p.y + 18;
        const len = 13 + perks.thruster * 4 * thrust + Math.sin(now / 45 + side) * 3 * thrust;
        const grad = ctx.createLinearGradient(nx, ny + 5, nx, ny + 5 + len);
        grad.addColorStop(0, "rgba(255,236,190,.95)");
        grad.addColorStop(0.45, "rgba(255,170,70,.7)");
        grad.addColorStop(1, "rgba(255,90,40,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(nx - 4.5, ny + 5);
        ctx.quadraticCurveTo(nx - 2, ny + 5 + len * 0.6, nx, ny + 5 + len);
        ctx.quadraticCurveTo(nx + 2, ny + 5 + len * 0.6, nx + 4.5, ny + 5);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = "#20242e"; ctx.strokeStyle = "#d8b26a"; ctx.lineWidth = 1.6;
        rr(nx - 5, ny - 5, 10, 11, 3); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }
    // Hull plating: an armoured chassis behind the Friend that thickens with each level.
    if (perks.hull > 0) {
      const w = 54 + perks.hull * 5, h = 50 + perks.hull * 4;
      ctx.save();
      ctx.fillStyle = "rgba(30,24,13,.88)";
      ctx.strokeStyle = "rgba(216,178,106,.9)";
      ctx.lineWidth = 2.4;
      rr(p.x - w / 2, p.y - h / 2 - 4, w, h, 9);
      ctx.fill(); ctx.stroke();
      for (let i = 0; i < perks.hull; i++) {
        const wdt = 15 - i * 1.6, py = p.y - 15 + i * 11;
        ctx.fillStyle = "rgba(216,178,106,.95)"; ctx.strokeStyle = "#2a2210"; ctx.lineWidth = 1.3;
        for (const side of [-1, 1]) { rr(p.x + side * (w / 2) - wdt / 2, py, wdt, 8, 3); ctx.fill(); ctx.stroke(); }
      }
      ctx.restore();
    }
  };

  /** The weapon hardpoint, its muzzle flash, and the power core sit in front of the Friend. */
  const drawRigFront = (now: number) => {
    const perks = loadout.perks;
    if (perks.core > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 260);
      ctx.save();
      ctx.shadowColor = "#7ef9ff"; ctx.shadowBlur = 10 + perks.core * 4;
      ctx.fillStyle = "#d8fdff";
      ctx.beginPath(); ctx.arc(p.x, p.y + 3, 2.2 + perks.core * 0.7 + pulse * 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    // Fixed shoulder mount so it never collides with the thrusters; the barrel still tracks the aim.
    ctx.save();
    ctx.translate(p.x + 24, p.y - 14);
    ctx.fillStyle = "#20242e"; ctx.strokeStyle = "#d8b26a"; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.rotate(p.aim);
    ctx.fillStyle = "#20242e"; ctx.strokeStyle = weapon.tint; ctx.lineWidth = 1.8; ctx.lineJoin = "round";
    if (loadout.weapon === "scatter") {
      for (const a of [-0.3, 0, 0.3]) { ctx.save(); ctx.rotate(a); rr(9, -3, 19, 6, 2); ctx.fill(); ctx.stroke(); ctx.restore(); }
    } else if (loadout.weapon === "lance") {
      rr(6, -2.5, 32, 5, 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = weapon.tint; ctx.beginPath(); ctx.arc(38, 0, 3, 0, Math.PI * 2); ctx.fill();
    } else if (loadout.weapon === "orbiter") {
      rr(6, -5, 15, 10, 4); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = "#9ef7ff"; ctx.lineWidth = 2;
      for (const side of [-1, 1]) { ctx.beginPath(); ctx.moveTo(3, side * 7); ctx.lineTo(17, side * 12); ctx.stroke(); }
    } else {
      rr(6, -3.5, 24, 7, 3); ctx.fill(); ctx.stroke();
    }
    if (p.flash > 0) {
      const k = p.flash / 0.07;
      const len = loadout.weapon === "lance" ? 42 : 30;
      ctx.globalAlpha = k;
      ctx.fillStyle = "#fff6d8"; ctx.shadowColor = weapon.tint; ctx.shadowBlur = 22;
      ctx.beginPath(); ctx.moveTo(len, 0); ctx.lineTo(len - 13, -9 * k); ctx.lineTo(len - 4, 0); ctx.lineTo(len - 13, 9 * k); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
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
    for (const w of warns) {
      const k = 1 - w.t / 0.55, c = w.k === 2 ? "180,140,255" : w.k === 1 ? "255,180,84" : "255,92,138";
      ctx.strokeStyle = `rgba(${c},${0.35 + k * 0.5})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(w.x, w.y, 34 * (1 - k) + 10, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(w.x, w.y, 10 * k, 0, Math.PI * 2); ctx.stroke();
    }
    for (const e of enemies) drawFoe(e, now);
    ctx.globalCompositeOperation = "lighter";
    for (const s of shots) { ctx.fillStyle = s.c; ctx.shadowColor = s.c; ctx.shadowBlur = 14; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill(); }
    for (let i = 0; i < weapon.orbs; i++) {
      const a = t / 0.7 + i * Math.PI, o = 62;
      ctx.fillStyle = "#9ef7ff"; ctx.shadowColor = "#9ef7ff"; ctx.shadowBlur = 20;
      ctx.beginPath(); ctx.arc(p.x + Math.cos(a) * o, p.y + Math.sin(a) * o, 7, 0, Math.PI * 2); ctx.fill();
    }
    for (const q of parts) { ctx.globalAlpha = Math.max(0, q.life * 2); ctx.fillStyle = q.c; ctx.fillRect(q.x, q.y, q.r, q.r); }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = "source-over";
    const frame = sprite(p.face, p.walk, p.walk ? Math.floor(now / 110) % 8 : 0);
    const blink = p.inv > 0 && Math.floor(now / 70) % 2 === 0;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.beginPath(); ctx.ellipse(p.x, p.y + 26, 22, 7, 0, 0, Math.PI * 2); ctx.fill();
    drawRigBehind(now);
    ctx.globalAlpha = blink ? 0.35 : 1; ctx.shadowColor = flash > 0 ? "#ff6b7a" : "#5ee7d0"; ctx.shadowBlur = 20;
    if (frame) ctx.drawImage(frame, p.x - 32, p.y - 40, 64, 64);
    else { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(p.x, p.y - 8, 16, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    drawRigFront(now);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = vignette; ctx.fillRect(0, 0, W, H);
    if (flash > 0) { ctx.fillStyle = `rgba(255,60,80,${flash * 0.6})`; ctx.fillRect(0, 0, W, H); }
    ctx.fillStyle = "rgba(238,242,247,.14)"; ctx.fillRect(0, 0, W, 6);
    ctx.fillStyle = "#5ee7d0"; ctx.fillRect(0, 0, W * Math.min(1, p.xp / p.need), 6);
    ctx.fillStyle = "rgba(10,12,18,.7)"; ctx.fillRect(22, 22, 264, 22);
    ctx.fillStyle = p.hp > maxHp * 0.35 ? "#d8b26a" : "#ff6b7a"; ctx.fillRect(26, 26, 256 * Math.max(0, p.hp) / maxHp, 14);
    const rem = Math.max(0, Math.ceil(RUN - t));
    ctx.fillStyle = "#eef2f7"; ctx.textBaseline = "top";
    ctx.textAlign = "center"; ctx.font = "700 40px ui-sans-serif,system-ui,sans-serif";
    ctx.fillText(`${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, "0")}`, W / 2, 14);
    ctx.textAlign = "right"; ctx.font = "600 24px ui-sans-serif,system-ui,sans-serif";
    ctx.fillText(`LV ${p.lvl}  ·  ${kills} kills`, W - 24, 20);
    ctx.textAlign = "left"; ctx.font = "600 13px ui-sans-serif,system-ui,sans-serif";
    ctx.fillStyle = "rgba(216,178,106,.75)";
    ctx.fillText(weapon.name.toUpperCase(), 26, 54);
    if (bannerT > 0) {
      const k = Math.min(1, bannerT / 0.5);
      ctx.globalAlpha = k;
      ctx.textAlign = "center"; ctx.font = "800 34px ui-sans-serif,system-ui,sans-serif";
      ctx.fillStyle = "#d8b26a"; ctx.shadowColor = "#d8b26a"; ctx.shadowBlur = 26;
      ctx.fillText(banner, W / 2, H / 2 - 120);
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
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
      else p.hp = Math.min(maxHp, p.hp + 40);
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [muted, setMuted] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [sprites, setSprites] = useState<Sprites | null>(null);
  const [loadout, setLoadout] = useState<Loadout>({ weapon: "blaster", perks: emptyPerks() });
  // Weapons are owned once bought, so a purchase is never lost by equipping something else.
  const [ownedWeapons, setOwnedWeapons] = useState<Weapon[]>(["blaster"]);
  const [shopSpent, setShopSpent] = useState(0n);
  const [stats, setStats] = useState<Stats>({ runs: 0, kills: 0, best: 0, bestRank: "—", rfSpent: 0n, rfEarned: 0n, caches: 0n });
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
  const available = snapshot ? snapshot.rfBalance - shopSpent : 0n;
  // The Armory may never take the last RF needed for a Run Ticket, otherwise a
  // player can spend themselves into a state where they cannot play to earn more.
  const ticketPrice = definition.price;
  const armoryBudget = available > ticketPrice ? available - ticketPrice : 0n;

  useEffect(() => {
    const version = ++epoch.current;
    // Audio starts enabled: a muted kit never allocates an AudioContext at all,
    // so the default has to be on or the game is silent forever.
    sound.current = createFriendSoundKit({ muted: false });
    const wake = () => { void sound.current?.unlock(); };
    window.addEventListener("pointerdown", wake, { once: true, capture: true });
    window.addEventListener("keydown", wake, { once: true, capture: true });
    setSnapshot(null); setMenu(null); setPhase("menu"); setResult(null); setError(""); setMessage(""); setBusy(false); setMuted(false); setSprites(null); locked.current = false;
    void client.read().then(value => { if (version === epoch.current) setSnapshot(value); })
      .catch(cause => { if (version === epoch.current) setError(cause instanceof Error ? cause.message : "Could not load the preview."); });
    void createFriendReader().read(friendId).then(value => { if (version === epoch.current) setSprites(value); }).catch(() => undefined);
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => {
      epoch.current++; core.current?.stop(); core.current = null;
      sound.current?.dispose(); sound.current = null;
      window.removeEventListener("pointerdown", wake, { capture: true } as EventListenerOptions);
      window.removeEventListener("keydown", wake, { capture: true } as EventListenerOptions);
      preference.removeEventListener("change", update);
    };
  }, [client, friendId]);

  useEffect(() => {
    if (!runId || !canvas.current) return;
    const game = engine(canvas.current, () => spritesRef.current, day * 2654435761 + runId, loadout, {
      paused: () => live.current.paused,
      reduced: () => live.current.reduced,
      cue: (cue, volume) => sound.current?.play(cue, volume === undefined ? undefined : { volume }),
      onLevel: list => { setChoices(list); setPhase("levelup"); },
      onEnd: done => {
        setSummary(done);
        setPhase("chest");
        setStats(prev => ({
          ...prev,
          runs: prev.runs + 1,
          kills: prev.kills + done.kills,
          best: Math.max(prev.best, done.score),
          bestRank: done.score > prev.best ? rankOf(done.score) : prev.bestRank,
        }));
      },
    });
    core.current = game;
    return () => { game.stop(); core.current = null; };
  }, [runId]);

  const choose = (id: Up) => { sound.current?.play("select"); core.current?.pick(id); setPhase("play"); };

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

  const buyWeapon = (id: Weapon) => {
    const w = WEAPONS[id];
    if (loadout.weapon === id) return;
    if (ownedWeapons.includes(id)) {
      // Already paid for: switching back is free.
      sound.current?.play("select");
      setLoadout(prev => ({ ...prev, weapon: id }));
      setMessage(`${w.name} equipped. No further spend.`);
      return;
    }
    if (w.price > armoryBudget) return;
    sound.current?.play("purchase");
    setShopSpent(s => s + w.price);
    setOwnedWeapons(list => [...list, id]);
    setLoadout(prev => ({ ...prev, weapon: id }));
    setStats(prev => ({ ...prev, rfSpent: prev.rfSpent + w.price }));
    setMessage(`${w.name} purchased and equipped. Simulated ${rf(w.price)} spend.`);
  };             

  const buyPerk = (id: Perk) => {
    const perk = PERKS[id], level = loadout.perks[id];
    if (level >= perk.max || perk.price > armoryBudget) return;
    sound.current?.play("purchase");
    setShopSpent(s => s + perk.price);
    setLoadout(prev => ({ ...prev, perks: { ...prev.perks, [id]: level + 1 } }));
    setStats(prev => ({ ...prev, rfSpent: prev.rfSpent + perk.price }));
    setMessage(`${perk.name} level ${level + 1}. Simulated ${rf(perk.price)} spend.`);
  };

  const startRun = () => {
    void sound.current?.unlock();
    sound.current?.play("action-start");
    setSummary(null); setResult(null); setError(""); setMessage("");
    setPhase("play"); setRunId(value => value + 1);
  };

  const feedback = <p className="od-status" role={error ? "alert" : "status"}>{error || message || (busy ? "Waiting for preview confirmation…" : "Simulated RF and outcomes. Score and rank are cosmetic and never change odds.")}</p>;

  if (!snapshot) return (
    <div className="od-loading" role={error ? "alert" : "status"}>{error || "Booting Overdrive…"}
      {error && <button type="button" disabled={busy || paused} onClick={() => void act(async () => undefined)}>Retry</button>}
    </div>
  );
  if (snapshot.friendId !== friendId) return <p role="alert">This game session does not match the selected Friend.</p>;

  const maxPrize = maximumPrize(definition);
  const canBuy = available >= definition.price && snapshot.freeStake >= maxPrize && snapshot.freeStake + definition.price >= maxPrize;
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
    if (version === epoch.current) {
      setResult(settled);
      setPhase("reveal");
      setStats(prev => ({ ...prev, caches: prev.caches + 1n }));
      const tier = settled.outcomeId ?? 1;
      sound.current?.play(tier >= 4 ? "reveal-legendary" : tier === 3 ? "reveal-rare" : "reveal-common");
    }
  }, undefined);

  const soundToggle = (
    <button type="button" aria-pressed={!muted} onClick={() => { const next = !muted; setMuted(next); sound.current?.setMuted(next); if (!next) void sound.current?.unlock(); }}>
      {muted ? "Sound: off" : "Sound: on"}
    </button>
  );

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
            <span className="od-chip">Preview · {rf(available)} · {snapshot.consumables.toString()} tickets</span>
            <button type="button" onClick={() => { sound.current?.play("select"); setMenu("odds"); }}>Odds</button>
            <button type="button" onClick={() => { sound.current?.play("select"); setMenu("inventory"); }}>Vault · {count.toString()}</button>
            <button type="button" onClick={() => { sound.current?.play("select"); setMenu("settings"); }}>Settings</button>
          </header>
          <div className="od-hero">
            <small>Daily arena #{day % 10000} · same spawns for everyone</small>
            <h1>OVERDRIVE</h1>
            <p>75 seconds. Your Rare Friend holds the line against the glitch swarm. Survive, level up, then crack the cache.</p>
            <div className="od-loadout">
              <span className="od-slot"><b>{WEAPONS[loadout.weapon].name}</b><small>equipped weapon</small></span>
              {PERK_IDS.map(id => (
                <span className="od-slot" key={id}><b>{loadout.perks[id]}/{PERKS[id].max}</b><small>{PERKS[id].name}</small></span>
              ))}
            </div>
            <div className="od-nav">
              <button type="button" onClick={() => { sound.current?.play("select"); setPhase("armory"); }}>Armory</button>
              <button type="button" onClick={() => { sound.current?.play("select"); setPhase("pilot"); }}>Pilot profile</button>
            </div>
            {ready
              ? <button type="button" className="od-cta" disabled={busy || paused} onClick={startRun}>Start run</button>
              : <button type="button" className="od-cta" disabled={!canBuy || busy || paused} onClick={() => void act(() => client.buy(1n), "purchase", () => setMessage("One simulated Run Ticket added."))}>Buy Run Ticket · {rf(definition.price)}</button>}
            {!ready && !canBuy && <p className="od-best">{available < definition.price ? "Not enough simulated RF." : "New tickets are paused until there is enough free backing."}</p>}
          </div>
          <footer className="od-foot">{feedback}</footer>
        </div>
      )}

      {phase === "armory" && (
        <div className="od-screen">
          <header className="od-top">
            <span className="od-chip">Armory · {rf(armoryBudget)} spendable</span>
            <button type="button" onClick={() => { sound.current?.play("select"); setPhase("menu"); }}>Back</button>
          </header>
          <div className="od-scroll">
            <p className="od-note">Every purchase is a <b>simulated RF spend</b> from this preview balance. One Run Ticket ({rf(ticketPrice)}) is always held back so you can never spend yourself out of playing. Upgrades last for this session only — the sandbox has no save API, so nothing persists across a reload.</p>
            <h3 className="od-sub">Weapons</h3>
            {WEAPON_IDS.map(id => {
              const w = WEAPONS[id];
              const equipped = loadout.weapon === id, has = ownedWeapons.includes(id);
              const locked = !has && w.price > armoryBudget;
              const stats = [
                `${(1 / w.rate).toFixed(1)}/s`,
                w.shots > 1 ? `${w.shots} pellets` : null,
                w.pierce > 0 ? `pierce ${w.pierce}` : null,
                w.orbs > 0 ? `${w.orbs} drones` : null,
              ].filter(Boolean).join(" · ");
              return (
                <div className={`od-item${equipped ? " od-owned" : ""}`} key={id}>
                  <span>
                    <strong>{w.name}{has && !equipped ? " · owned" : ""}</strong>
                    <small>{w.blurb}</small>
                    <small>{stats} · {has ? "no further spend" : rf(w.price)}</small>
                  </span>
                  <button type="button" disabled={equipped || locked || busy || paused} onClick={() => buyWeapon(id)}>
                    {equipped ? "Equipped" : has ? "Equip" : locked ? "Need RF" : `Buy · ${rf(w.price)}`}
                  </button>
                </div>
              );
            })}
            <h3 className="od-sub">Systems</h3>
            {PERK_IDS.map(id => {
              const perk = PERKS[id], level = loadout.perks[id], maxed = level >= perk.max, locked = perk.price > armoryBudget;
              return (
                <div className={`od-item${maxed ? " od-owned" : ""}`} key={id}>
                  <span><strong>{perk.name} · Lv {level}/{perk.max}</strong><small>{perk.blurb} · {rf(perk.price)}</small></span>
                  <button type="button" disabled={maxed || locked || busy || paused} onClick={() => buyPerk(id)}>
                    {maxed ? "Maxed" : locked ? "Need RF" : `Upgrade · ${rf(perk.price)}`}
                  </button>
                </div>
              );
            })}
            <p className="od-note">Weapons you buy stay in your rack — switching back is free, so nothing you paid for is lost. Every system is drawn on the Friend in the arena: plating on the shoulders, thrusters below with live exhaust, the coil as a pickup ring, and the core as a chest emitter.</p>
            <p className="od-note">Total simulated RF spent this session: <b>{rf(stats.rfSpent)}</b></p>
          </div>
          <footer className="od-foot">{feedback}</footer>
        </div>
      )}

      {phase === "pilot" && (
        <div className="od-screen">
          <header className="od-top">
            <span className="od-chip">Pilot · session record</span>
            <button type="button" onClick={() => { sound.current?.play("select"); setPhase("menu"); }}>Back</button>
          </header>
          <div className="od-scroll">
            <p className="od-note">Session-only: the SDK sandbox has no storage, so this record resets on reload.</p>
            <div className="od-grid">
              <div className="od-stat"><b>{stats.runs}</b><small>runs flown</small></div>
              <div className="od-stat"><b>{stats.best}</b><small>best score</small></div>
              <div className="od-stat"><b>{stats.bestRank}</b><small>best rank</small></div>
              <div className="od-stat"><b>{stats.kills}</b><small>total kills</small></div>
              <div className="od-stat"><b>{stats.caches.toString()}</b><small>caches cracked</small></div>
              <div className="od-stat"><b>{rf(stats.rfEarned)}</b><small>RF redeemed</small></div>
              <div className="od-stat"><b>{rf(stats.rfSpent)}</b><small>RF spent (shop)</small></div>
              <div className="od-stat"><b>{WEAPONS[loadout.weapon].name}</b><small>current weapon</small></div>
              <div className="od-stat"><b>{ownedWeapons.length}/{WEAPON_IDS.length}</b><small>weapons owned</small></div>
            </div>
            <h3 className="od-sub">Equipped</h3>
            {PERK_IDS.map(id => (
              <div className="od-item" key={id}>
                <span><strong>{PERKS[id].name}</strong><small>{PERKS[id].blurb}</small></span>
                <span className="od-level">Lv {loadout.perks[id]}/{PERKS[id].max}</span>
              </div>
            ))}
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
            <button type="button" disabled={busy || paused} onClick={() => { sound.current?.play("select"); setPhase("menu"); setResult(null); }}>Keep it</button>
            <button type="button" className="od-cta" disabled={busy || paused} onClick={() => void act(() => client.redeem(result!.outcomeId!, 1n), "reward", () => {
              setStats(prev => ({ ...prev, rfEarned: prev.rfEarned + outcome.reward }));
              setPhase("menu"); setResult(null); setMessage("Redeemed in the simulated ledger.");
            })}>Redeem · {rf(outcome.reward)}</button>
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
                <button type="button" disabled={busy || paused || snapshot.inventory[index] === 0n} onClick={() => void act(() => client.redeem(index + 1, 1n), "reward", () => setStats(prev => ({ ...prev, rfEarned: prev.rfEarned + item.reward })))}>Redeem one</button>
              </div>
            ))}
          </> : <>
            {soundToggle}
            <label><input type="checkbox" checked={reduced} onChange={event => setReduced(event.target.checked)} /> Reduce motion</label>
            <p>All economy actions are simulated. Reloading resets this preview. Wallet connection and ownership verification are provided by the SDK.</p>
          </>}
          {feedback}
        </GameMenu>
      )}

      {playing && (
        <div className="od-hudbtns">
          <button type="button" aria-label={muted ? "Unmute sound" : "Mute sound"} onClick={() => { const next = !muted; setMuted(next); sound.current?.setMuted(next); if (!next) void sound.current?.unlock(); }}>
            {muted ? "🔇" : "🔊"}
          </button>
        </div>
      )}
    </section>
  );
}
