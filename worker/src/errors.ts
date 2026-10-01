export type BoardStatus = 400 | 404 | 409 | 500

export class BoardError extends Error {
  readonly status: BoardStatus

  constructor(message: string, status: BoardStatus) {
    super(message)
    this.name = "BoardError"
    this.status = status
  }
}
