export function dequeueNext<T>(queue: T[]): T | undefined {
  return queue.shift();
}

export function removeByRequestId<T extends { requestId: string }>(
  queue: T[],
  requestId: string,
): T | undefined {
  const index = queue.findIndex((entry) => entry.requestId === requestId);
  if (index < 0) {
    return undefined;
  }

  const [removed] = queue.splice(index, 1);
  return removed;
}
