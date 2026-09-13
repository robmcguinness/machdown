/** `plural(3, 'tab')` is "3 tabs"; pass the irregular form for "1 category" / "2 categories". */
export const plural = (count: number, noun: string, many = `${noun}s`): string =>
  `${count} ${count === 1 ? noun : many}`;
