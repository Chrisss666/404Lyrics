/* 404Lyrics - fullscreen visualizer.
 *
 * "Aurora Orb": the album art as a slowly turning disc, ringed by layered,
 * smoothed radial curves driven by Spotify's audio analysis (segment loudness /
 * pitch / timbre and the beat grid), looked up against the playback clock.
 * Beats fire expanding shockwaves; a small pool of particles drifts outward.
 *
 * Everything here is decorative and self-contained: if the analysis endpoint is
 * missing or slow the same drawing code is fed a synthetic signal, and any
 * failure to get a 2D context turns the whole thing into a no-op. It never
 * throws into the lyric view. One canvas, one rAF loop, no React work per frame.
 */
const LXVisualizer = (() => {
	const N = 128; // points around the ring
	const BANDS = 12;
	const TAU = Math.PI * 2;
	const cache = new Map(); // uri -> analysis | null

	const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
	const lerp = (a, b, t) => a + (b - a) * t;

	/* ------------------------------------------------------------- analysis */

	function normalise(raw) {
		if (!raw || !Array.isArray(raw.segments) || !raw.segments.length) return null;
		const segs = raw.segments.map((s) => ({
			s: s.start * 1000,
			d: Math.max(1, s.duration * 1000),
			l0: s.loudness_start,
			lm: s.loudness_max,
			tm: Math.max(1, (s.loudness_max_time || 0) * 1000),
			p: s.pitches || [],
			t: s.timbre || [],
		}));
		const beats = (raw.beats || []).map((b) => b.start * 1000);
		return { segs, beats };
	}

	/* Fetch + normalise the analysis for a track. Resolves to null (never
	 * rejects) when Spotify won't give it, so callers just keep the synthetic
	 * signal. Results are cached per URI for the session. */
	function loadAnalysis(uri) {
		if (!uri) return Promise.resolve(null);
		if (cache.has(uri)) return Promise.resolve(cache.get(uri));
		if (typeof Spicetify === "undefined" || typeof Spicetify.getAudioData !== "function") return Promise.resolve(null);
		return Promise.resolve()
			.then(() => Spicetify.getAudioData(uri))
			.then((raw) => {
				const an = normalise(raw);
				cache.set(uri, an);
				return an;
			})
			.catch(() => null);
	}

	// Index of the last item whose key <= pos (or -1).
	function lastAtOrBefore(arr, pos, key) {
		let lo = 0;
		let hi = arr.length - 1;
		let ans = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (key(arr[mid]) <= pos) {
				ans = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		return ans;
	}

	/* One instantaneous reading: overall level, 12 band values and a beat clock.
	 * Written into `out` so the frame loop allocates nothing. */
	function sample(an, pos, out) {
		const si = lastAtOrBefore(an.segs, pos, (s) => s.s);
		if (si >= 0) {
			const seg = an.segs[si];
			const next = an.segs[si + 1];
			const local = pos - seg.s;
			let db;
			if (local < seg.tm) db = lerp(seg.l0, seg.lm, local / seg.tm);
			else db = lerp(seg.lm, next ? next.l0 : seg.l0, clamp01((local - seg.tm) / Math.max(1, seg.d - seg.tm)));
			out.level = Math.pow(clamp01((db + 42) / 42), 1.5);
			for (let i = 0; i < BANDS; i++) {
				const pitch = seg.p[i] != null ? seg.p[i] : 0.3;
				const tim = seg.t[i + 1] != null ? Math.tanh(seg.t[i + 1] / 110) * 0.5 + 0.5 : 0.4;
				out.bands[i] = clamp01(pitch * 0.72 + tim * 0.28);
			}
		} else {
			out.level = 0.1;
			out.bands.fill(0.2);
		}
		const bi = lastAtOrBefore(an.beats, pos, (b) => b);
		out.beatIndex = bi;
		out.pulse = bi >= 0 ? Math.exp(-(pos - an.beats[bi]) / 190) : 0;
	}

	// Stand-in signal used until (or instead of) real analysis.
	function synth(t, out) {
		out.level = 0.42 + 0.22 * Math.sin(t / 930) + 0.1 * Math.sin(t / 317);
		for (let i = 0; i < BANDS; i++) out.bands[i] = 0.5 + 0.42 * Math.sin(t / (520 + i * 137) + i * 1.7);
		out.beatIndex = Math.floor(t / 520);
		out.pulse = Math.exp(-(t % 520) / 190);
	}

	/* -------------------------------------------------------------- colour */

	function parseHex(hex) {
		const h = String(hex || "").replace("#", "");
		const n = Number.parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
		if (!Number.isFinite(n)) return [139, 92, 246];
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	}
	const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
	const mixWhite = (c, t) => [lerp(c[0], 255, t), lerp(c[1], 255, t), lerp(c[2], 255, t)];

	/* ------------------------------------------------------------ renderer */

	function create(canvas, host) {
		const ctx = canvas.getContext && canvas.getContext("2d");
		if (!ctx) return null;

		const state = {
			an: null,
			intensity: 1,
			reduced: false,
			accent: parseHex("#8b5cf6"),
			base: parseHex("#161821"),
			tAccent: parseHex("#8b5cf6"),
			tBase: parseHex("#161821"),
			img: null,
			prevImg: null,
			imgFade: 1,
		};

		const reading = { level: 0, bands: new Array(BANDS).fill(0), beatIndex: -1, pulse: 0 };
		const target = new Float32Array(N);
		const tmp = new Float32Array(N);
		const cur = new Float32Array(N); // main ring, fast release
		const e1 = new Float32Array(N); // echo rings, progressively slower
		const e2 = new Float32Array(N);
		const px = new Float32Array(N);
		const py = new Float32Array(N);

		const shocks = [];
		const particles = Array.from({ length: 34 }, () => ({ a: Math.random() * TAU, r: Math.random(), v: 0.00006 + Math.random() * 0.00008, s: 0.6 + Math.random() * 1.4, w: (Math.random() - 0.5) * 0.00018 }));

		let W = 0;
		let H = 0;
		let raf = 0;
		let last = 0;
		let clock = 0; // own monotonic ms, drives idle/synthetic motion + disc spin
		let lastBeat = -1;
		let level = 0; // smoothed overall level
		let pulse = 0; // smoothed beat pulse
		let quiet = 0; // consecutive settled frames while paused
		let dead = false;

		/* ------------------------------------------------------------ sizing */
		function resize() {
			const r = canvas.getBoundingClientRect();
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			const w = Math.max(1, Math.round(r.width));
			const h = Math.max(1, Math.round(r.height));
			const pw = Math.round(w * dpr);
			const ph = Math.round(h * dpr);
			if (canvas.width !== pw || canvas.height !== ph) {
				canvas.width = pw;
				canvas.height = ph;
			}
			W = w;
			H = h;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		}

		let observer = null;
		if (typeof ResizeObserver === "function") {
			observer = new ResizeObserver(() => {
				resize();
				if (!raf) draw(performance.now(), true); // repaint a stopped/still frame
			});
			observer.observe(host || canvas);
		}
		resize();

		/* --------------------------------------------------------- artwork */
		function setArt(url) {
			if (!url) {
				state.prevImg = state.img;
				state.img = null;
				state.imgFade = 0;
				return;
			}
			const img = new Image();
			img.onload = () => {
				if (dead) return;
				state.prevImg = state.img;
				state.img = img;
				state.imgFade = 0;
				if (!raf) draw(performance.now(), true);
			};
			img.src = url;
		}

		/* ------------------------------------------------------------- frame */
		function compute(pos, playing, dt) {
			const k = dt / 16.7;
			if (playing) {
				if (state.an) sample(state.an, pos, reading);
				else synth(clock, reading);
			} else {
				// Paused: settle into a slow, quiet breathing rather than freezing.
				reading.level = 0.14 + 0.04 * Math.sin(clock / 1400);
				for (let i = 0; i < BANDS; i++) reading.bands[i] = 0.22 + 0.1 * Math.sin(clock / 1700 + i);
				reading.pulse = 0;
				reading.beatIndex = lastBeat;
			}

			level += (reading.level - level) * Math.min(1, (reading.level > level ? 0.28 : 0.07) * k);
			pulse += (reading.pulse - pulse) * Math.min(1, (reading.pulse > pulse ? 0.6 : 0.16) * k);

			// Beat -> shockwave (only on the natural next beat, never after a seek).
			if (playing && reading.beatIndex !== lastBeat) {
				if (lastBeat >= 0 && reading.beatIndex === lastBeat + 1 && shocks.length < 4 && !state.reduced) shocks.push({ age: 0, str: 0.5 + level * 0.5 });
				lastBeat = reading.beatIndex;
			}

			// Band values around the ring, mirrored about the vertical axis so it
			// reads as a symmetric bloom. Fine sine detail is layered on top and
			// scaled by loudness, so quiet passages stay clean and loud ones bristle.
			const drive = 0.22 + level * 0.95;
			for (let i = 0; i < N; i++) {
				const f = i / N;
				const m = Math.abs(2 * f - 1);
				const bp = m * (BANDS - 1);
				const b0 = Math.floor(bp);
				const b1 = Math.min(BANDS - 1, b0 + 1);
				const band = lerp(reading.bands[b0], reading.bands[b1], bp - b0);
				const fine = 0.5 + 0.25 * (Math.sin(i * 1.7 + clock * 0.006) + Math.sin(i * 0.63 - clock * 0.0041));
				tmp[i] = (band * 0.62 + fine * 0.38) * drive;
			}
			for (let i = 0; i < N; i++) target[i] = (tmp[(i + N - 1) % N] + tmp[i] * 2 + tmp[(i + 1) % N]) * 0.25;

			for (let i = 0; i < N; i++) {
				const t = target[i];
				cur[i] += (t - cur[i]) * Math.min(1, (t > cur[i] ? 0.5 : 0.14) * k);
				e1[i] += (cur[i] - e1[i]) * Math.min(1, 0.06 * k);
				e2[i] += (e1[i] - e2[i]) * Math.min(1, 0.045 * k);
			}

			// Palette eases toward the new track's colours instead of snapping.
			for (let c = 0; c < 3; c++) {
				state.accent[c] += (state.tAccent[c] - state.accent[c]) * Math.min(1, 0.05 * k);
				state.base[c] += (state.tBase[c] - state.base[c]) * Math.min(1, 0.05 * k);
			}
			if (state.imgFade < 1) state.imgFade = Math.min(1, state.imgFade + dt / 700);

			for (const s of shocks) s.age += dt;
			while (shocks.length && shocks[0].age > 1700) shocks.shift();
			for (const p of particles) {
				p.r += p.v * dt * (0.5 + level * 1.4);
				p.a += p.w * dt;
				if (p.r > 1) {
					p.r = 0;
					p.a = Math.random() * TAU;
				}
			}
		}

		// Closed, smooth curve through the ring points (midpoint quadratic).
		function ringPath(arr, r0, amp, cx, cy) {
			for (let i = 0; i < N; i++) {
				const a = (i / N) * TAU - Math.PI / 2;
				const r = r0 + amp * arr[i];
				px[i] = cx + Math.cos(a) * r;
				py[i] = cy + Math.sin(a) * r;
			}
			ctx.beginPath();
			ctx.moveTo((px[N - 1] + px[0]) / 2, (py[N - 1] + py[0]) / 2);
			for (let i = 0; i < N; i++) {
				const j = (i + 1) % N;
				ctx.quadraticCurveTo(px[i], py[i], (px[i] + px[j]) / 2, (py[i] + py[j]) / 2);
			}
			ctx.closePath();
		}

		function drawDisc(cx, cy, rd, spin) {
			const drawImg = (img, alpha) => {
				if (!img || alpha <= 0) return;
				const iw = img.naturalWidth || img.width;
				const ih = img.naturalHeight || img.height;
				if (!iw || !ih) return;
				const s = (rd * 2) / Math.min(iw, ih);
				ctx.save();
				ctx.globalAlpha = alpha;
				ctx.translate(cx, cy);
				ctx.rotate(spin);
				ctx.drawImage(img, (-iw * s) / 2, (-ih * s) / 2, iw * s, ih * s);
				ctx.restore();
			};

			ctx.save();
			ctx.globalCompositeOperation = "source-over";
			ctx.beginPath();
			ctx.arc(cx, cy, rd, 0, TAU);
			ctx.clip();
			// Backing so a missing / fading image never shows a hole.
			const bg = ctx.createRadialGradient(cx - rd * 0.3, cy - rd * 0.3, rd * 0.1, cx, cy, rd);
			bg.addColorStop(0, rgba(mixWhite(state.accent, 0.1), 1));
			bg.addColorStop(1, rgba(state.base, 1));
			ctx.fillStyle = bg;
			ctx.fillRect(cx - rd, cy - rd, rd * 2, rd * 2);
			drawImg(state.prevImg, 1 - state.imgFade);
			drawImg(state.img, state.imgFade);
			// Soft inner shading + a spindle dimple make it read as a record.
			const shade = ctx.createRadialGradient(cx, cy, rd * 0.55, cx, cy, rd);
			shade.addColorStop(0, "rgba(0,0,0,0)");
			shade.addColorStop(1, "rgba(0,0,0,0.38)");
			ctx.fillStyle = shade;
			ctx.fillRect(cx - rd, cy - rd, rd * 2, rd * 2);
			ctx.restore();

			ctx.save();
			ctx.lineWidth = 1.5;
			ctx.strokeStyle = rgba(mixWhite(state.accent, 0.55), 0.35);
			ctx.beginPath();
			ctx.arc(cx, cy, rd, 0, TAU);
			ctx.stroke();
			ctx.restore();
		}

		function draw(now, still) {
			if (dead || !W || !H) return;
			const dt = still ? 16.7 : Math.min(64, now - last || 16.7);
			last = now;
			clock += dt;

			const playing = LXPlayer.playing();
			const pos = LXPlayer.progress();
			if (still) {
				// One-off frame (reduced motion / repaint while stopped): a calm,
				// fully-formed ring at a fixed moderate level, no beat effects.
				for (let i = 0; i < 40; i++) compute(pos, false, 16.7);
			} else compute(pos, playing, dt);

			const I = state.intensity;
			const cx = W * 0.5;
			const cy = H * 0.5;
			const R = Math.min(W, H) * 0.5 * 0.9; // outermost reach
			const rd = R * 0.36 * (1 + pulse * 0.045 * I); // disc radius
			const r0 = R * 0.5; // ring base radius
			const amp = R * 0.46 * I; // ring excursion
			const acc = state.accent;
			const light = mixWhite(acc, 0.42);

			ctx.clearRect(0, 0, W, H);
			ctx.globalCompositeOperation = "lighter";

			// Ambient bloom behind everything - swells with loudness.
			const bloom = ctx.createRadialGradient(cx, cy, rd * 0.4, cx, cy, R * 1.25);
			bloom.addColorStop(0, rgba(acc, 0.22 + level * 0.22 * I));
			bloom.addColorStop(0.55, rgba(acc, 0.07 + level * 0.06 * I));
			bloom.addColorStop(1, rgba(acc, 0));
			ctx.fillStyle = bloom;
			ctx.fillRect(0, 0, W, H);

			// Shockwaves.
			for (const s of shocks) {
				const t = s.age / 1700;
				const e = 1 - Math.pow(1 - t, 3);
				ctx.strokeStyle = rgba(light, Math.pow(1 - t, 2) * 0.34 * s.str * I);
				ctx.lineWidth = 1 + (1 - t) * 2.2;
				ctx.beginPath();
				ctx.arc(cx, cy, rd * 1.05 + (R * 1.18 - rd) * e, 0, TAU);
				ctx.stroke();
			}

			// Echo rings (trailing, slower) then the main ring.
			const layers = [
				[e2, 0.78, 0.05, 0.22, 1],
				[e1, 0.9, 0.07, 0.36, 1.2],
				[cur, 1, 0.13, 0.95, 1.8],
			];
			for (const [arr, scale, fillA, strokeA, lw] of layers) {
				ringPath(arr, r0, amp * scale, cx, cy);
				const g = ctx.createRadialGradient(cx, cy, r0 * 0.6, cx, cy, r0 + amp);
				g.addColorStop(0, rgba(acc, 0));
				g.addColorStop(0.55, rgba(acc, fillA));
				g.addColorStop(1, rgba(light, fillA * 0.4));
				ctx.fillStyle = g;
				ctx.fill();
				// Layered strokes fake a glow far cheaper than shadowBlur.
				ctx.lineJoin = "round";
				ctx.strokeStyle = rgba(acc, strokeA * 0.07);
				ctx.lineWidth = lw * 11;
				ctx.stroke();
				ctx.strokeStyle = rgba(acc, strokeA * 0.16);
				ctx.lineWidth = lw * 5;
				ctx.stroke();
				ctx.strokeStyle = rgba(light, strokeA);
				ctx.lineWidth = lw;
				ctx.stroke();
			}

			// Inner counter-ring: the same data turned inside out, thin and quiet.
			ringPath(e1, r0 * 0.9, -amp * 0.22, cx, cy);
			ctx.strokeStyle = rgba(light, 0.2);
			ctx.lineWidth = 1;
			ctx.stroke();

			// Fine radial ticks just outside the bloom - the "high detail" layer.
			ctx.beginPath();
			const tickR = r0 + amp * 1.08 + R * 0.05;
			for (let i = 0; i < N; i++) {
				const a = (i / N) * TAU - Math.PI / 2;
				const len = 3 + R * 0.16 * I * cur[i];
				const c = Math.cos(a);
				const s = Math.sin(a);
				ctx.moveTo(cx + c * tickR, cy + s * tickR);
				ctx.lineTo(cx + c * (tickR + len), cy + s * (tickR + len));
			}
			ctx.strokeStyle = rgba(light, 0.4);
			ctx.lineWidth = 1.4;
			ctx.lineCap = "round";
			ctx.stroke();

			// Drifting particles.
			if (!state.reduced || still) {
				for (const p of particles) {
					const rr = rd * 1.15 + p.r * R * 1.05;
					const a = p.a + p.r * 1.6;
					const alpha = Math.sin(p.r * Math.PI) * 0.6 * (0.4 + level);
					if (alpha <= 0.01) continue;
					ctx.fillStyle = rgba(light, alpha);
					ctx.beginPath();
					ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, p.s * (1 + level * 0.8), 0, TAU);
					ctx.fill();
				}
			}

			// The disc itself, on top, in normal blending.
			ctx.globalCompositeOperation = "source-over";
			drawDisc(cx, cy, rd, state.reduced ? 0 : clock * 0.00004);

			// Idle detection: once paused and settled, stop the loop entirely.
			if (!still && !playing) {
				let settle = Math.abs(reading.level - level);
				for (let i = 0; i < N; i += 8) settle += Math.abs(target[i] - cur[i]);
				quiet = settle < 0.05 && shocks.length === 0 && state.imgFade >= 1 ? quiet + 1 : 0;
			} else quiet = 0;
		}

		/* -------------------------------------------------------------- loop */
		function step(now) {
			raf = 0;
			if (dead) return;
			draw(now, false);
			if (quiet < 90) raf = requestAnimationFrame(step);
		}

		function start() {
			if (dead) return;
			resize();
			if (state.reduced) {
				stop();
				draw(performance.now(), true);
				return;
			}
			if (raf) return;
			last = performance.now();
			quiet = 0;
			raf = requestAnimationFrame(step);
		}

		function stop() {
			if (raf) cancelAnimationFrame(raf);
			raf = 0;
		}

		return {
			start,
			stop,
			// Wake the loop after a pause / seek without doing work if it's live.
			poke() {
				if (state.reduced) return draw(performance.now(), true);
				if (!raf) start();
				quiet = 0;
			},
			setPalette(pal) {
				if (!pal) return;
				state.tAccent = parseHex(pal.accent);
				state.tBase = parseHex(pal.base);
				if (!raf) draw(performance.now(), true);
			},
			setArt,
			setAnalysis(an) {
				state.an = an || null;
				lastBeat = -1;
			},
			setIntensity(v) {
				state.intensity = Number.isFinite(v) ? v : 1;
			},
			setReduced(b) {
				b = !!b;
				if (b === state.reduced) return;
				state.reduced = b;
				if (b) {
					stop();
					draw(performance.now(), true);
				} else start();
			},
			destroy() {
				dead = true;
				stop();
				if (observer) observer.disconnect();
				state.img = state.prevImg = null;
			},
		};
	}

	return { create, loadAnalysis };
})();
