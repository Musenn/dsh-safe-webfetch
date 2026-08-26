export class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  async acquire(signal) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaseOnce();
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: null };
      entry.onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        next.signal?.removeEventListener("abort", next.onAbort);
        next.resolve(this.releaseOnce());
      } else {
        this.active -= 1;
      }
    };
  }
}
