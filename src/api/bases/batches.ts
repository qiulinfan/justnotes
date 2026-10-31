// Rendering a long result in batches: the first batch at once, the rest as a
// sentinel after them scrolls into view. A base over a whole vault can have
// thousands of rows.
const BATCH = 200;

export class BatchRenderer {
	#observer: IntersectionObserver | null = null;
	#sentinel: HTMLElement | null = null;

	// `scrollEl` scrolls the rendered items; `scrollTop` is restored after a rerender.
	render(scrollEl: HTMLElement, tasks: (() => void)[], scrollTop = 0) {
		this.stop();
		let next = 0;
		const batch = () => {
			const end = Math.min(tasks.length, next + BATCH);
			for (; next < end; next++) tasks[next]();
			return next < tasks.length;
		};
		batch();
		while (scrollTop > 0 && next < tasks.length && scrollEl.scrollHeight < scrollTop + scrollEl.clientHeight) batch();
		scrollEl.scrollTop = scrollTop;
		if (next >= tasks.length) return;
		const sentinel = scrollEl.createDiv("bases-batch-sentinel");
		this.#sentinel = sentinel;
		const observer = new IntersectionObserver((records) => {
			if (!records.some((r) => r.isIntersecting)) return;
			if (!batch()) {
				this.stop();
				return;
			}
			// Observing again reports at once if the sentinel is still in view.
			scrollEl.appendChild(sentinel);
			observer.unobserve(sentinel);
			observer.observe(sentinel);
		});
		observer.observe(sentinel);
		this.#observer = observer;
	}

	stop() {
		this.#observer?.disconnect();
		this.#observer = null;
		this.#sentinel?.detach();
		this.#sentinel = null;
	}
}
