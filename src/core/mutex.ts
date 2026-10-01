/**
 * Promise-chain mutex. Durable Object input gates do not cover awaited fetches, and a local host
 * serves concurrent requests, so every project mutation runs through one of these.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  private pending = 0

  /** True while a task is running or waiting. */
  get busy(): boolean {
    return this.pending > 0
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending++
    const result = this.tail.then(task)
    const release = () => {
      this.pending--
    }
    this.tail = result.then(release, release)
    return result
  }

  /** Runs the task only when nothing else holds the lock. Returns undefined when skipped. */
  tryRun<T>(task: () => Promise<T>): Promise<T> | undefined {
    if (this.busy) return undefined
    return this.run(task)
  }
}
