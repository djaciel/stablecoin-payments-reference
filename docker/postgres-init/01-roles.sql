-- Runs once, the first time the postgres volume is created.
--
-- Temporal shares the Postgres INSTANCE with the application, which the spec allows, but
-- it has no business reading the payments schema. Sharing one superuser between them made
-- the separation a matter of configuration; this makes it a matter of permissions.

-- Temporal creates its own `temporal` and `temporal_visibility` databases at startup, so
-- the role needs CREATEDB and nothing else. It is not a superuser.
--
-- The role is deliberately NOT called `temporal`: the auto-setup image skips creating a
-- database whose name matches the connecting user, assuming it is already there. Same
-- name, and the server starts up against a database that does not exist.
CREATE ROLE temporal_user LOGIN PASSWORD 'temporal' CREATEDB;

-- By default any role may connect to any database. Take that back: only the owner
-- (`payments`) gets in from here on.
REVOKE CONNECT ON DATABASE payments FROM PUBLIC;

-- Note on what is NOT fixed here: the application's own role is the instance superuser,
-- because that is the role the postgres image creates from POSTGRES_USER. A production
-- deployment would give the application a plain role owning only its schema. Left as is
-- so the demo keeps one obvious set of credentials.
