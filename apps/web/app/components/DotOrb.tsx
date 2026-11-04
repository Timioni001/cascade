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

    const draw = (time: number) => {
      ctx.clearRect(0, 0, size, size);
      const a = time * 0.00018;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      // The falling band: from top (-1.2) to bottom (1.2) every ~3.2s.
      const band = ((time / 3200) % 1) * 2.4 - 1.2;
      for (const p of pts) {
        const x = p.x * cos - p.z * sin;
        const z = p.x * sin + p.z * cos;
        const depth = (z + 1) / 2; // 0 back .. 1 front
        const glow = Math.max(0, 1 - Math.abs(p.y - band) * 7) * (z > -0.2 ? 1 : 0.3);
        const r = 0.6 + depth * 1.3 + glow * 1.2;
        ctx.globalAlpha = Math.min(1, 0.06 + depth * 0.42 + glow * 0.55);
        ctx.fillStyle = ink;
        ctx.beginPath();
        ctx.arc(c + x * radius, c + p.y * radius, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!still && visible) raf = requestAnimationFrame(draw);
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
