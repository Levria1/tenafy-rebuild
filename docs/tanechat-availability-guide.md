# Superseded — see `tanechat-integration-guide.md`

This availability-only guide has been replaced by
**[`tanechat-integration-guide.md`](./tanechat-integration-guide.md)**, which covers the same
`/vacancies` migration plus the viewing relay, and reflects two changes made after this file was
written:

- the **hard gap cap** (`hard_max_gap_days`, default 20) now REMOVES units from the response, so an
  empty list is meaningful rather than a sign of no inventory
- **partner forwarding** — TaneChat sends `partner_forward.message` when nothing is suitable

Both change the contract, so anything built from this file needs revisiting. Kept as a pointer rather
than deleted so old links still lead somewhere correct.
