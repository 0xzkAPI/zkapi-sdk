import { formatEtherExact, parseEtherExact, quoteSend } from '../src/index.js';

const quote = quoteSend(parseEtherExact('0.1'), 20);
console.log({
  grossEth: formatEtherExact(quote.grossWei),
  feeEth: formatEtherExact(quote.feeWei),
  recipientEth: formatEtherExact(quote.netWei),
});
