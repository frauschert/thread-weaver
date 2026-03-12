/** A simple push-pull async queue that implements AsyncIterable. */
export class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private buffer: T[] = [];
  private waiters: {
    resolve: (result: IteratorResult<T>) => void;
    reject: (err: unknown) => void;
  }[] = [];
  private err: unknown = undefined;
  private hasError = false;
  private finished = false;

  push(value: T) {
    if (this.finished) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  done() {
    this.finished = true;
    for (const w of this.waiters) {
      w.resolve({ value: undefined as any, done: true });
    }
    this.waiters.length = 0;
  }

  error(err: unknown) {
    this.err = err;
    this.hasError = true;
    this.finished = true;
    for (const w of this.waiters) {
      w.reject(err);
    }
    this.waiters.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      return Promise.resolve({ value: this.buffer.shift()!, done: false });
    }
    if (this.hasError) {
      return Promise.reject(this.err);
    }
    if (this.finished) {
      return Promise.resolve({ value: undefined as any, done: true });
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}
