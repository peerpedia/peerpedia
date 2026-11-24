/** Keep asynchronous filesystem discovery from steering a newer editor selection. */
export class WorkspaceContext {
  private sequence = 0;
  constructor(private readonly resolve: (path: string) => Promise<string | undefined>,
    private readonly activate: (root: string, path: string) => Promise<void>) {}

  async follow(path: string): Promise<void> {
    const sequence = ++this.sequence;
    const root = await this.resolve(path);
    if (sequence !== this.sequence || root === undefined) return;
    await this.activate(root, path);
  }

  cancel(): void { ++this.sequence; }
}
