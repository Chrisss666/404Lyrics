/* 404Lyrics - synchronisation math.
 *
 * Pure functions: given parsed lines and a playback position, which line is
 * active and how far through it are we. No Spotify access, no DOM - so it is
 * trivial to reason about and cheap to call every animation frame.
 */
const LXSync = (() => {
	// Index of the line that should be active at `positionMs`, or -1 when
	// playback is still ahead of the first timed line (the intro).
	// `lines` must be sorted ascending by `time`; the providers guarantee that.
	function activeIndex(lines, positionMs) {
		if (!lines || !lines.length) return -1;
		if (positionMs < (lines[0].time || 0)) return -1;

		let lo = 0;
		let hi = lines.length - 1;
		let result = 0;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if ((lines[mid].time || 0) <= positionMs) {
				result = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		return result;
	}

	// 0..1 progress through the active line, based on the gap to the next one.
	// Used only for the hairline underline on the active line. Falls back to a
	// gentle 6s ramp for the very last line, which has no "next" to measure to.
	function lineProgress(lines, index, positionMs) {
		if (index < 0 || !lines || !lines[index]) return 0;
		const start = lines[index].time || 0;
		const next = lines[index + 1] ? lines[index + 1].time : start + 6000;
		const span = next - start;
		if (span <= 0) return 0;
		const frac = (positionMs - start) / span;
		return frac < 0 ? 0 : frac > 1 ? 1 : frac;
	}

	return { activeIndex, lineProgress };
})();
