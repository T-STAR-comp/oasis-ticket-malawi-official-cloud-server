/** Orders that pay resale sellers — not organizer primary-ticket revenue. */
export const EXCLUDE_RESALE_ORDERS_SQL = `
  AND NOT EXISTS (
    SELECT 1 FROM resell_sales rs WHERE rs.order_id = o.id
  )
`;
