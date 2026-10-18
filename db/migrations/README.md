# Database migrations

Files are named `NNNN_description.up.sql`, with an optional `NNNN_description.down.sql` for rollback.
Applied migrations are recorded in `schema_migrations` with a checksum; editing an applied
migration is refused, so add a new migration instead.

    npm --prefix api run migrate -- up      # apply pending migrations
    npm --prefix api run migrate -- down    # roll back the latest migration
