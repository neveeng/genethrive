# GeneThrive — reconciled backend (locked Supabase schema + working dashboard/alert function + Shopify/Portal pipeline)

This project reconciles THREE pieces that were previously built separately
into ONE coherent backend on Paul's locked, approved Supabase schema. See
**CHANGELOG.md** for the full reasoning, what changed and why, and an honest
list of what's proven vs. still unverified pending a live Supabase project.

## Layout

```
genethrive_backend/
  supabase_schema.sql              # THE locked schema — tables, RLS, client_pipeline view
  CHANGELOG.md                     # full reconciliation writeup — read this first
  dashboard/
    GeneThrive_ChainOversightDashboard_SourceCode_ForDeployment_18Sep2026.html
                                    # the already-built ops dashboard — unmodified during the
                                    # original reconciliation; a 5th tile (kit_dispatch_overdue)
                                    # was added on top on 27 Sep 2026 (later still) — see CHANGELOG.md
  alertfn/
    sla-logic.js, check-sla-breaches.js, notify-on-change.js, README.txt
                                    # UNMODIFIED — the already-built SMS alert function
  netlify/
    functions/
      _lib/supabase-rest.js        # shared PostgREST helper (select/selectAll/insert/update/upsert)
      _lib/wizard-to-engine-intake.js  # UNCHANGED converter (wizard record -> Engine's genethrive.intake.v1)
      shopify-order-webhook.js     # Shopify orders/paid -> client_contacts + orders + status_events + sla_clocks
      get-intake-prefill.js        # intake_token -> safe prefill subset (orders -> client_contacts)
      submit-health-profile.js     # intake submission -> health_profiles (CLINICAL)
      list-clients.js              # Barbara's portal client list (naturopath-scoped, NOT ops)
      get-client-full-record.js    # Barbara's "Open in Engine" full record (naturopath-scoped)
      save-dna-result.js           # DNA extract -> dna_results (CLINICAL) + results.landed status_events
  portal/
    barbara_portal.html            # UNCHANGED — PIN gate + Open-in-Engine handoff
    GeneThrive_Engine_v3.5.147_WITH_PortalHandoff.html
    ENGINE_PATCH_PortalHandoff.md
  local-test-server/
    mock-supabase.js               # generic multi-table PostgREST mock (select/insert/update/upsert)
    sql/test_auth_shim.sql         # LOCAL TEST ONLY stand-in for Supabase's auth.uid()/roles
    test-end-to-end.js             # Shopify webhook -> prefill -> submit-health-profile
    test-barbara-portal.js         # list-clients / get-client-full-record / save-dna-result + portal jsdom test
    test-wizard-to-engine-intake.js
    test-full-chain-wizard-to-protocol.js
    test-client-pipeline-view.js   # REAL Postgres 16 test of supabase_schema.sql itself (view + RLS)
```

## Deploying

Deploy `netlify/`, `portal/`, and `dashboard/` as one Netlify site (functions
dir: `netlify/functions`). Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
in Netlify's environment variables, plus `SHOPIFY_WEBHOOK_SECRET` for the
webhook. Apply `supabase_schema.sql` once, in the Supabase SQL editor, against
the project's Sydney (ap-southeast-2) database — see that file's own header
comment for exactly what it assumes already exists (Supabase's `auth` schema,
`pgcrypto`, the standard `anon`/`authenticated`/`service_role` roles).

Point the dashboard's `CONFIG.supabase` (inside
`dashboard/GeneThrive_ChainOversightDashboard_SourceCode_ForDeployment_18Sep2026.html`)
at the real project URL + anon key, `CONFIG.supabase.table` stays
`'client_pipeline'` (it already is), and flip `CONFIG.mode` to `'supabase'` —
nothing else in that file needs to change. Deploy `alertfn/`'s two Node files
per its own `README.txt` (unchanged).

## Running the tests

```
npm install       # installs the `pg` package used by the real-Postgres test
npm test          # runs all five test files in sequence
```

Or individually:
```
node local-test-server/test-end-to-end.js
node local-test-server/test-barbara-portal.js
node local-test-server/test-wizard-to-engine-intake.js
node local-test-server/test-full-chain-wizard-to-protocol.js
node local-test-server/test-client-pipeline-view.js
```

### Running the real-Postgres test (`test-client-pipeline-view.js`)

Every other test file needs nothing but Node. This one needs a real local
Postgres 16 with `supabase_schema.sql` actually applied — it proves the real
SQL (the `client_pipeline` view and the RLS policies), not a JS mirror of it.
One-time setup:

```bash
# Start Postgres (already installed in this container)
pg_ctlcluster 16 main start

# Create a test role + database
sudo -u postgres psql -c "CREATE ROLE genethrive_test LOGIN PASSWORD 'genethrive_test' SUPERUSER;"
sudo -u postgres psql -c "CREATE DATABASE genethrive_test OWNER genethrive_test;"

# Apply the local-only auth shim, THEN the real, unedited schema
export PGPASSWORD=genethrive_test
psql -h localhost -U genethrive_test -d genethrive_test -f local-test-server/sql/test_auth_shim.sql
psql -h localhost -U genethrive_test -d genethrive_test -f supabase_schema.sql
psql -h localhost -U genethrive_test -d genethrive_test -c "grant select, insert, update, delete on all tables in schema public to service_role;"
psql -h localhost -U genethrive_test -d genethrive_test -c "grant usage on schema public to anon, authenticated, service_role;"
```

Then `node local-test-server/test-client-pipeline-view.js` (or `npm test`,
which runs it last). If it can't reach Postgres, it SKIPS with a loud warning
(exit 0) rather than failing the whole suite — every other test file has no
such dependency.

**This test does NOT prove real Supabase/GoTrue/PostgREST behaviour** — see
CHANGELOG.md "What's proven vs. what's still unverified".
