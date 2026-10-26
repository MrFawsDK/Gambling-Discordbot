// Shared by games with fractional multipliers (slots, mines). Payouts are rounded down to
// whole coins. Working in hundredths keeps the float math exact, so 30 × 1.3 is 39 and not
// 38.99999 rounded down to 38. Multipliers are therefore only precise to two decimals.
export function payout(bet, multiplier) {
  return Math.floor((bet * Math.round(multiplier * 100)) / 100);
}
