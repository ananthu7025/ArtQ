# Seed data

`postal-codes.sample.csv` is a **small illustrative sample** in the column format of the India Post
"All India Pincode Directory" (data.gov.in). It exists for local development and tests only; its rows are
not an authoritative copy of the directory.

For staging/production, download the current directory CSV from data.gov.in and run:

```bash
pnpm --filter @artq/api db:seed --postal-codes /path/to/all_india_pincode_directory.csv
```

The import only uses the `officename`, `pincode`, `district` and `statename` columns, is idempotent, and reports
rows it skips (invalid pincode, unknown state, missing fields). Postal codes are geography only: they never decide
whether ArtQ delivers to a pincode (`pincode_serviceability`, database.md §3.2).
