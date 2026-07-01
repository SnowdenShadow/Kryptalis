-- Self-hosted git providers (Gitea / Forgejo). Unlike GitHub/GitLab/Bitbucket
-- (fixed SaaS hosts), these run on an operator-chosen host, so a GitProvider
-- row needs to remember its instance base URL (e.g. https://git.acme.com). The
-- column is the host we pin every API call + clone against for that provider.
-- NULL for the SaaS providers (back-compat: existing rows keep working with the
-- canonical-host model).
ALTER TABLE "git_providers" ADD COLUMN "baseUrl" TEXT;
