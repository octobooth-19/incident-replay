'use strict';

function quote(items) {
  const subtotalCents = items.reduce(
    (total, { unitPriceCents, quantity }) => total + unitPriceCents * quantity,
    0,
  );
  const shippingCents = subtotalCents >= 5000 ? 0 : 500;
  return { subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents };
}

if (require.main === module) {
  console.log(JSON.stringify(quote([{ unitPriceCents: 2500, quantity: 2 }])));
}

module.exports = { quote };
