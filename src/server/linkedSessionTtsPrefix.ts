export interface LinkedSessionPrefixLabelSource {
  workspace: string;
  resolvedTitle: string;
  sessionId: string;
}

export interface ApplyLinkedSessionPrefixParams {
  originalText: string;
  sanitizedText: string;
  sessionLabel?: string;
  prependEnabled: boolean;
}

export interface ApplyLinkedSessionPrefixResult {
  originalText: string;
  sanitizedText: string;
  prefixed: boolean;
}

export function formatLinkedSessionPrefixLabel(source: LinkedSessionPrefixLabelSource): string {
  const workspace = source.workspace.trim();
  const title = source.resolvedTitle.trim() || source.sessionId.trim();
  if (workspace.length > 0) {
    return `${workspace}, ${title}`;
  }
  return title;
}

export function applyLinkedSessionPrefixToTurnText(
  params: ApplyLinkedSessionPrefixParams,
): ApplyLinkedSessionPrefixResult {
  const label = params.sessionLabel?.trim().replace(/\s+/g, " ");
  if (!params.prependEnabled || !label) {
    return {
      originalText: params.originalText,
      sanitizedText: params.sanitizedText,
      prefixed: false,
    };
  }
  const prefix = `${label}. `;
  return {
    originalText: params.originalText,
    sanitizedText: `${prefix}${params.sanitizedText}`,
    prefixed: true,
  };
}
