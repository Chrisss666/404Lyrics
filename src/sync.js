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

	/* ---- word-level (karaoke) ---- */

	// Index of the currently-sung word within a line's `words` array, or -1
	// before the first word. `words` are sorted ascending by `time`.
	function activeWord(words, positionMs) {
		if (!words || !words.length) return -1;
		if (positionMs < (words[0].time || 0)) return -1;
		let lo = 0;
		let hi = words.length - 1;
		let result = 0;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if ((words[mid].time || 0) <= positionMs) {
				result = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		return result;
	}

	// 0..1 fill of the active word. Uses the word's own end time, falling back
	// to the next word's start, then a short ramp. Clamped so a word that has
	// already ended reads as full and the next has not started early.
	function wordProgress(words, index, positionMs) {
		if (index < 0 || !words || !words[index]) return 0;
		const w = words[index];
		const start = w.time || 0;
		let end = w.endTime || (words[index + 1] ? words[index + 1].time : start + 400);
		if (end <= start) end = start + 120;
		const frac = (positionMs - start) / (end - start);
		return frac < 0 ? 0 : frac > 1 ? 1 : frac;
	}

	return { activeIndex, lineProgress, activeWord, wordProgress };
})();
