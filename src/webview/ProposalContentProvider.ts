import * as vscode from 'vscode';

/** Serves the proposed (not yet applied) content of a file, for the diff preview. */
export class ProposalContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'mitram-proposed';

  private readonly contents = new Map<string, string>();
  private readonly byApproval = new Map<string, string[]>();

  /** Content computed on demand, so a snapshot that already lives elsewhere is not copied here. */
  private resolver?: (uri: vscode.Uri) => string | undefined;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? this.resolver?.(uri) ?? '';
  }

  /** Serves any URI that was not stored with {@link set}. */
  setResolver(resolver: (uri: vscode.Uri) => string | undefined): void {
    this.resolver = resolver;
  }

  /** Stores content for one approval and returns the URI to diff against. */
  set(approvalId: string, relPath: string, side: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: ProposalContentProvider.scheme,
      path: `/${relPath}`,
      query: `${approvalId}-${side}`,
    });
    this.contents.set(uri.toString(), text);
    this.byApproval.set(approvalId, [...(this.byApproval.get(approvalId) ?? []), uri.toString()]);
    return uri;
  }

  clear(approvalId: string): void {
    for (const key of this.byApproval.get(approvalId) ?? []) this.contents.delete(key);
    this.byApproval.delete(approvalId);
  }
}
