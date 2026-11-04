"use client";

import { useEffect, useRef } from "react";

/**
 * A sphere of dots that slowly turns while a band of light falls through it:
 * the "cascade". 2D canvas, no WebGL, ~1,100 points. Pauses when off-screen
 * and draws a single still frame for prefers-reduced-motion.
 */
export function DotOrb({ size = 420, points = 1150, className }: { size?: number; points?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    // Fibonacci sphere: evenly spread points.
    const golden = Math.PI * (3 - Math.sqrt(5));
    const pts = Array.from({ length: points }, (_, i) => {
      const y = 1 - (i / (points - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const t = golden * i;
      return { x: Math.cos(t) * r, y, z: Math.sin(t) * r };
    });

    const styles = getComputedStyle(document.documentElement);
    const ink = styles.getPropertyValue("--ink").trim() || "#111112";
    const radius = size * 0.42;
    const c = size / 2;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let visible = true;
    let last = -Infinity;
    // Dots are grouped into a few opacity levels and each level is filled
    // once: ~12 fills a frame instead of ~1,150. A slow rotation needs only 24 fps.
    const LEVELS = 12;
    const paths = Array.from({ length: LEVELS }, () => new Path2D());
    const FRAME_MS = 1000 / 24;

    const draw = (time: number) => {
      if (!still && visible) raf = requestAnimationFrame(draw);
      if (time - last < FRAME_MS - 1) return;
      last = time;
      ctx.clearRect(0, 0, size, size);
      const a = time * 0.00018;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      // The falling band: from top (-1.2) to bottom (1.2) every ~3.2s.
      const band = ((time / 3200) % 1) * 2.4 - 1.2;
      for (let i = 0; i < LEVELS; i++) paths[i] = new Path2D();
      for (const p of pts) {
        const x = p.x * cos - p.z * sin;
        const z = p.x * sin + p.z * cos;
        const depth = (z + 1) / 2; // 0 back .. 1 front
        const glow = Math.max(0, 1 - Math.abs(p.y - band) * 7) * (z > -0.2 ? 1 : 0.3);
        const r = 0.6 + depth * 1.3 + glow * 1.2;
        const alpha = Math.min(1, 0.06 + depth * 0.42 + glow * 0.55);
        const px = c + x * radius;
        const py = c + p.y * radius;
        const path = paths[Math.min(LEVELS - 1, Math.floor(alpha * LEVELS))]!;
        // Dots under ~2px across look the same as squares and are far cheaper to rasterize.
        if (r < 1.1) path.rect(px - r, py - r, r * 2, r * 2);
        else {
          path.moveTo(px + r, py);
          path.arc(px, py, r, 0, Math.PI * 2);
        }
      }
      ctx.fillStyle = ink;
      for (let i = 0; i < LEVELS; i++) {
        ctx.globalAlpha = (i + 0.5) / LEVELS;
        ctx.fill(paths[i]!);
      }
      ctx.globalAlpha = 1;
    };

    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
      cancelAnimationFrame(raf);
      if (visible) raf = requestAnimationFrame(draw);
    });
    io.observe(canvas);
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [size, points]);

  return <canvas ref={ref} className={className} style={{ width: size, height: size, maxWidth: "100%" }} aria-hidden="true" />;
}
