/** One policy at every result boundary; missing ruleSet is the legacy classic contract. */
export function isRankedMatch(match) {
  return Boolean(match && !match.practice && !match.training && !match.withBots && match.ranked !== false &&
    (match.ruleSet === undefined || match.ruleSet === 'classic'));
}
