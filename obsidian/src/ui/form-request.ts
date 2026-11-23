/** Track async results only for the current user input and live project/form. */
export class FormRequest {
  private generation = 0;
  cancel(): void { ++this.generation; }
  begin(current: () => boolean): () => boolean {
    const generation = ++this.generation;
    return (): boolean => this.generation === generation && current();
  }
}
