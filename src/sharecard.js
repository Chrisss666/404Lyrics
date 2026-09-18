/* 404Lyrics - shareable lyric cards.
 *
 * Pick a few lines, get a designed image (artwork-blurred backdrop, palette
 * glow, the lines set large, track credit underneath) that can be copied to
 * the clipboard or saved as a PNG. The card is drawn straight onto a canvas -
 * the same routine paints the live preview (scaled down) and the export
 * (full size), so what you see is exactly what you get.
 *
 * Everything degrades quietly: if the artwork can't be loaded with CORS the
 * card is drawn with a palette gradient instead (a tainted canvas can't be
 * exported), and clipboard failures fall back to a "use Save" hint.
 */
const LXShareCard = (() => {
	const ASPECTS = {
		square: { label: "Square", w: 1080, h: 1080 },
		story: { label: "Story", w: 1080, h: 1920 },
		wide: { label: "Wide", w: 1600, h: 900 },
	};
	const MAX_LINES = 8;

	/* --------------------------------------------------------------- helpers */

	function loadImage(url) {
		return new Promise((resolve) => {
			if (!url) return resolve(null);
			const img = new Image();
			img.crossOrigin = "anonymous"; // required, or the canvas is tainted and can't be exported
			img.onload = () => resolve(img);
			img.onerror = () => resolve(null);
			img.src = url;
		});
	}

	function hex(h) {
		const s = String(h || "").replace("#", "");
		const n = Number.parseInt(s.length === 3 ? s.replace(/./g, "$&$&") : s, 16);
		return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [139, 92, 246];
	}
	const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
	const toLight = (c, t) => c.map((v) => v + (255 - v) * t);

	function roundRect(ctx, x, y, w, h, r) {
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + w, y, x + w, y + h, r);
		ctx.arcTo(x + w, y + h, x, y + h, r);
		ctx.arcTo(x, y + h, x, y, r);
		ctx.arcTo(x, y, x + w, y, r);
		ctx.closePath();
	}

	function drawCover(ctx, img, x, y, w, h) {
		const iw = img.naturalWidth || img.width;
		const ih = img.naturalHeight || img.height;
		const s = Math.max(w / iw, h / ih);
		ctx.drawImage(img, x + (w - iw * s) / 2, y + (h - ih * s) / 2, iw * s, ih * s);
	}

	// Greedy word wrap using the context's current font.
	function wrap(ctx, text, maxW) {
		const words = text.split(/\s+/).filter(Boolean);
		const lines = [];
		let line = "";
		for (const word of words) {
			const test = line ? line + " " + word : word;
			if (line && ctx.measureText(test).width > maxW) {
				lines.push(line);
				line = word;
			} else line = test;
		}
		if (line) lines.push(line);
		return lines.length ? lines : [""];
	}

	function ellipsize(ctx, text, maxW) {
		if (ctx.measureText(text).width <= maxW) return text;
		let t = text;
		while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
		return t + "…";
	}

	/* Largest font size at which every selected line (plus optional translation)
	 * fits the box. Returns the wrapped blocks and their total height. */
	function fit(ctx, items, font, base, maxW, maxH) {
		const min = base * 0.4;
		for (let fs = base; fs >= min; fs -= 2) {
			const trFs = fs * 0.5;
			let total = 0;
			const blocks = items.map((it, idx) => {
				ctx.font = `700 ${fs}px ${font}`;
				const main = wrap(ctx, it.text, maxW);
				let tr = [];
				if (it.tr) {
					ctx.font = `500 ${trFs}px ${font}`;
					tr = wrap(ctx, it.tr, maxW);
				}
				const h = main.length * fs * 1.2 + (tr.length ? tr.length * trFs * 1.25 + fs * 0.12 : 0) + (idx ? fs * 0.34 : 0);
				total += h;
				return { main, tr, h, gap: idx ? fs * 0.34 : 0 };
			});
			if (total <= maxH || fs - 2 < min) return { fs, trFs, blocks, total };
		}
		return { fs: min, trFs: min * 0.5, blocks: [], total: 0 };
	}

	/* ------------------------------------------------------------------ draw */

	/* o: { aspect: {w,h}, info, palette, img, items: [{text, tr}], font }.
	 * `scale` shrinks the backing store for previews; layout is in card units. */
	function draw(canvas, o, scale) {
		const W = o.aspect.w;
		const H = o.aspect.h;
		const sc = scale || 1;
		canvas.width = Math.round(W * sc);
		canvas.height = Math.round(H * sc);
		const ctx = canvas.getContext("2d");
		if (!ctx) return false;
		ctx.setTransform(sc, 0, 0, sc, 0, 0);

		const acc = hex(o.palette && o.palette.accent);
		const base = hex(o.palette && o.palette.base);
		const font = o.font || 'system-ui, "Segoe UI", sans-serif';
		const m = Math.min(W, H);
		const P = Math.round(m * 0.085);

		// Backdrop: blurred artwork (or the palette base) under a tinted scrim.
		ctx.fillStyle = rgba(base, 1);
		ctx.fillRect(0, 0, W, H);
		if (o.img) {
			ctx.save();
			ctx.filter = `blur(${Math.round(m * 0.045 * sc)}px) saturate(1.25) brightness(0.62)`;
			const pad = m * 0.14;
			drawCover(ctx, o.img, -pad, -pad, W + pad * 2, H + pad * 2);
			ctx.restore();
		}
		const scrim = ctx.createLinearGradient(0, 0, 0, H);
		scrim.addColorStop(0, "rgba(6,6,10,0.22)");
		scrim.addColorStop(1, "rgba(6,6,10,0.74)");
		ctx.fillStyle = scrim;
		ctx.fillRect(0, 0, W, H);
		const glow = ctx.createRadialGradient(W * 0.14, H * 0.1, 0, W * 0.14, H * 0.1, Math.max(W, H) * 0.85);
		glow.addColorStop(0, rgba(acc, o.img ? 0.3 : 0.5));
		glow.addColorStop(1, rgba(acc, 0));
		ctx.fillStyle = glow;
		ctx.fillRect(0, 0, W, H);

		// Footer: artwork thumbnail, title / artist, brand mark.
		const S = Math.round(m * 0.11);
		const fy = H - P - S;
		ctx.save();
		roundRect(ctx, P, fy, S, S, S * 0.16);
		ctx.clip();
		if (o.img) drawCover(ctx, o.img, P, fy, S, S);
		else {
			const g = ctx.createLinearGradient(P, fy, P + S, fy + S);
			g.addColorStop(0, rgba(toLight(acc, 0.15), 1));
			g.addColorStop(1, rgba(base, 1));
			ctx.fillStyle = g;
			ctx.fillRect(P, fy, S, S);
		}
		ctx.restore();

		const tx = P + S + S * 0.28;
		const brand = "Created with 404Lyrics";
		ctx.font = `600 ${S * 0.2}px ${font}`;
		const brandW = ctx.measureText(brand).width;
		const textMax = W - P - tx - brandW - S * 0.4;
		ctx.textBaseline = "alphabetic";
		ctx.fillStyle = "rgba(255,255,255,0.96)";
		ctx.font = `700 ${S * 0.3}px ${font}`;
		ctx.fillText(ellipsize(ctx, (o.info && o.info.title) || "", textMax), tx, fy + S * 0.44);
		ctx.fillStyle = "rgba(255,255,255,0.66)";
		ctx.font = `500 ${S * 0.23}px ${font}`;
		ctx.fillText(ellipsize(ctx, (o.info && o.info.artist) || "", textMax), tx, fy + S * 0.78);
		ctx.fillStyle = "rgba(255,255,255,0.5)";
		ctx.font = `600 ${S * 0.2}px ${font}`;
		ctx.textAlign = "right";
		ctx.fillText(brand, W - P, fy + S * 0.78);
		ctx.textAlign = "left";

		// Lyric block, vertically centred in the space above the footer.
		const barW = Math.max(5, Math.round(W * 0.0055));
		const x0 = P + barW + P * 0.32;
		const areaTop = P;
		const areaBottom = fy - P * 0.6;
		const maxW = W - x0 - P;
		const laid = fit(ctx, o.items || [], font, m * 0.078, maxW, areaBottom - areaTop);
		let y = areaTop + Math.max(0, (areaBottom - areaTop - laid.total) / 2);
		const blockTop = y;

		ctx.textBaseline = "top";
		ctx.shadowColor = "rgba(0,0,0,0.35)";
		ctx.shadowBlur = laid.fs * 0.3;
		for (const b of laid.blocks) {
			y += b.gap;
			ctx.font = `700 ${laid.fs}px ${font}`;
			ctx.fillStyle = "#fff";
			for (const l of b.main) {
				ctx.fillText(l, x0, y);
				y += laid.fs * 1.2;
			}
			if (b.tr.length) {
				y += laid.fs * 0.12;
				ctx.font = `500 ${laid.trFs}px ${font}`;
				ctx.fillStyle = "rgba(255,255,255,0.64)";
				for (const l of b.tr) {
					ctx.fillText(l, x0, y);
					y += laid.trFs * 1.25;
				}
			}
		}
		ctx.shadowColor = "transparent";
		ctx.shadowBlur = 0;

		if (laid.blocks.length) {
			ctx.fillStyle = rgba(toLight(acc, 0.35), 0.95);
			roundRect(ctx, P, blockTop, barW, Math.max(barW, y - blockTop), barW / 2);
			ctx.fill();
		}
		return true;
	}

	// Full-size PNG of the card, or null if the canvas can't be exported.
	function toBlob(o) {
		const c = document.createElement("canvas");
		if (!draw(c, o, 1)) return Promise.resolve(null);
		return new Promise((resolve) => {
			try {
				c.toBlob((b) => resolve(b), "image/png");
			} catch (e) {
				resolve(null);
			}
		});
	}

	/* ---------------------------------------------------------------- dialog */

	function ShareDialog(props) {
		const R = Spicetify.React;
		const { info, palette, data, translations, onClose } = props;

		const items = R.useMemo(
			() => data.lines.map((l, i) => ({ i, text: (l.text || "").trim() })).filter((x) => x.text),
			[data]
		);
		const [sel, setSel] = R.useState(() => {
			const first = items.find((x) => x.i === props.initialIndex) || items[0];
			return first ? [first.i] : [];
		});
		const [aspect, setAspect] = R.useState("square");
		const [withTr, setWithTr] = R.useState(false);
		const [img, setImg] = R.useState(null);
		const [note, setNote] = R.useState("");
		const rootRef = R.useRef(null);
		const canvasRef = R.useRef(null);
		const hasTr = !!translations && Object.keys(translations).length > 0;

		const build = () => {
			const root = rootRef.current;
			const font = (root && getComputedStyle(root).getPropertyValue("--lx-lyric-font").trim()) || "system-ui, sans-serif";
			const byIndex = new Map(items.map((x) => [x.i, x.text]));
			return {
				aspect: ASPECTS[aspect],
				info,
				palette,
				img,
				font,
				items: sel.filter((i) => byIndex.has(i)).map((i) => ({ text: byIndex.get(i), tr: withTr && hasTr ? translations[byIndex.get(i)] || "" : "" })),
			};
		};

		R.useEffect(() => {
			let live = true;
			loadImage(info.image).then((i) => live && setImg(i));
			return () => {
				live = false;
			};
		}, [info.image]);

		R.useEffect(() => {
			if (canvasRef.current) draw(canvasRef.current, build(), 0.42);
		}, [sel, aspect, withTr, img, palette]);

		R.useEffect(() => {
			const root = rootRef.current;
			if (!root) return;
			root.focus();
			const row = root.querySelector(".lx-share__row.is-on");
			if (row && row.scrollIntoView) row.scrollIntoView({ block: "center" });
		}, []);

		const toggle = (i) => {
			if (sel.includes(i)) setSel(sel.filter((x) => x !== i));
			else if (sel.length >= MAX_LINES) setNote(`Up to ${MAX_LINES} lines per card`);
			else {
				setSel(sel.concat(i).sort((a, b) => a - b));
				setNote("");
			}
		};

		const withBlob = (fn) =>
			toBlob(build()).then((blob) => (blob ? fn(blob) : setNote("Couldn’t render the image")));

		const copy = () =>
			withBlob((blob) => {
				if (!navigator.clipboard || typeof ClipboardItem === "undefined") return setNote("Copy isn’t supported here — use Save");
				return navigator.clipboard
					.write([new ClipboardItem({ "image/png": blob })])
					.then(() => setNote("Copied to clipboard"))
					.catch(() => setNote("Copy was blocked — use Save instead"));
			});

		const save = () =>
			withBlob((blob) => {
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = (`${info.title} - ${info.artist}`.replace(/[\\/:*?"<>|]+/g, "").trim() || "lyric-card") + ".png";
				document.body.appendChild(a);
				a.click();
				a.remove();
				setTimeout(() => URL.revokeObjectURL(url), 4000);
				setNote("Saved as " + a.download);
			});

		const a = ASPECTS[aspect];

		return h(
			"div",
			{
				className: "lx-share",
				role: "dialog",
				"aria-modal": "true",
				"aria-label": "Share a lyric card",
				tabIndex: -1,
				ref: rootRef,
				onMouseDown: (e) => {
					if (e.target === e.currentTarget) onClose();
				},
				onKeyDown: (e) => {
					if (e.key === "Escape") {
						e.stopPropagation();
						onClose();
					}
				},
			},
			h(
				"div",
				{ className: "lx-share__panel" },
				h("div", { className: "lx-share__preview" }, h("canvas", { className: "lx-share__canvas", ref: canvasRef, style: { aspectRatio: `${a.w} / ${a.h}` } })),
				h(
					"div",
					{ className: "lx-share__side" },
					h(
						"div",
						{ className: "lx-share__head" },
						h("p", { className: "lx-share__title" }, "Share a lyric card"),
						h("button", { type: "button", className: "lx-share__close", onClick: onClose, "aria-label": "Close" }, "×")
					),
					h("p", { className: "lx-share__hint" }, `Pick up to ${MAX_LINES} lines · ${sel.length} selected`),
					h(
						"div",
						{ className: "lx-share__list", role: "group", "aria-label": "Lyric lines" },
						items.map((it) =>
							h(
								"button",
								{
									key: it.i,
									type: "button",
									className: "lx-share__row" + (sel.includes(it.i) ? " is-on" : ""),
									"aria-pressed": sel.includes(it.i),
									onClick: () => toggle(it.i),
								},
								h("span", { className: "lx-share__check", "aria-hidden": "true" }),
								h("span", { className: "lx-share__line" }, it.text)
							)
						)
					),
					h(
						"div",
						{ className: "lx-share__opts" },
						h(
							"div",
							{ className: "lx-share__segs", role: "group", "aria-label": "Format" },
							Object.keys(ASPECTS).map((k) =>
								h(
									"button",
									{ key: k, type: "button", className: "lx-share__seg" + (k === aspect ? " is-on" : ""), "aria-pressed": k === aspect, onClick: () => setAspect(k) },
									ASPECTS[k].label
								)
							)
						),
						hasTr
							? h(
									"button",
									{ type: "button", className: "lx-share__tog" + (withTr ? " is-on" : ""), role: "switch", "aria-checked": withTr, onClick: () => setWithTr(!withTr) },
									h("span", { className: "lx-share__tick", "aria-hidden": "true" }),
									"Include translation"
								)
							: null
					),
					h(
						"div",
						{ className: "lx-share__actions" },
						h("button", { type: "button", className: "lx-share__btn lx-share__btn--primary", disabled: !sel.length, onClick: copy }, "Copy image"),
						h("button", { type: "button", className: "lx-share__btn", disabled: !sel.length, onClick: save }, "Save PNG")
					),
					h("p", { className: "lx-share__note", role: "status", "aria-live": "polite" }, note)
				)
			)
		);
	}

	return { ShareDialog, draw, toBlob, ASPECTS, MAX_LINES };
})();
