// Marketplace compose templates.
//
// Every template uses these per-install placeholders so each install is
// isolated:
//
//   __HOST_PORT__   → canonical host-side port (Application.port). Caddy
//                     publishes this same port on the host when the user
//                     picks a port-pinned binding.
//   __INSTANCE_ID__ → first 12 chars of Application.id. Used for container
//                     names AND volume namespaces so two instances of the
//                     same image can coexist on one host.
//
// Every template ALSO attaches to the `dockcontrol-apps` external network so
// Caddy can reach the container by name. The network is created by the root
// docker-compose. Marketplace install MAY strip the host `ports:` block
// when a port-pinned binding is requested — Caddy publishes the port on
// the host in that case, so the container only needs the internal port.
import { checkVolumeSafety } from './dto/install-custom.dto';

export const COMPOSE_TEMPLATES: Record<string, { compose: string; healthCheck?: string }> = {
  portainer: {
    compose: `services:
  portainer:
    image: portainer/portainer-ce:lts
    container_name: dockcontrol-portainer-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      # 9000 = Portainer's plain-HTTP listener. The dashboard links users to
      # http://<ip>:<hostPort>, so mapping the HTTPS listener (9443, self-signed)
      # here made every direct visit a 400 "Client sent an HTTP request to an
      # HTTPS server".
      - "__HOST_PORT__:9000"
      - "8000:8000"
    env_file:
      - .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - portainer_data___INSTANCE_ID__:/data
volumes:
  portainer_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  grafana: {
    compose: `services:
  grafana:
    image: grafana/grafana:latest
    container_name: dockcontrol-grafana-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:3000"
    volumes:
      - grafana_data___INSTANCE_ID__:/var/lib/grafana
    env_file:
      - .env
    environment:
      - GF_SECURITY_ADMIN_USER=\${GF_SECURITY_ADMIN_USER:-admin}
      - GF_SECURITY_ADMIN_PASSWORD=\${GF_SECURITY_ADMIN_PASSWORD:-__RANDOM_PASSWORD__}
volumes:
  grafana_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  'uptime-kuma': {
    compose: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    container_name: dockcontrol-uptime-kuma-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:3001"
    env_file:
      - .env
    volumes:
      - uptime_data___INSTANCE_ID__:/app/data
volumes:
  uptime_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  n8n: {
    compose: `services:
  n8n:
    image: n8nio/n8n:latest
    container_name: dockcontrol-n8n-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:5678"
    env_file:
      - .env
    volumes:
      - n8n_data___INSTANCE_ID__:/home/node/.n8n
    environment:
      - N8N_SECURE_COOKIE=\${N8N_SECURE_COOKIE:-false}
volumes:
  n8n_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  wordpress: {
    compose: `services:
  wordpress:
    image: wordpress:latest
    container_name: dockcontrol-wordpress-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:80"
    env_file:
      - .env
    environment:
      # container_name, NOT the bare service name: the service-name alias
      # lives on the SHARED dockcontrol-apps network, so two WordPress
      # installs would both answer to "wordpress-db" and round-robin
      # each other's DB traffic. The instance-suffixed container_name is
      # unique per install.
      WORDPRESS_DB_HOST: dockcontrol-wordpress-db-__INSTANCE_ID__
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: __RANDOM_PASSWORD__
      WORDPRESS_DB_NAME: wordpress
    volumes:
      - wp_data___INSTANCE_ID__:/var/www/html
    depends_on:
      - wordpress-db
  wordpress-db:
    image: mariadb:11
    container_name: dockcontrol-wordpress-db-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    environment:
      MYSQL_DATABASE: wordpress
      MYSQL_USER: wordpress
      MYSQL_PASSWORD: __RANDOM_PASSWORD__
      MYSQL_ROOT_PASSWORD: __RANDOM_PASSWORD_2__
    volumes:
      - wp_db___INSTANCE_ID__:/var/lib/mysql
volumes:
  wp_data___INSTANCE_ID__:
  wp_db___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  ghost: {
    compose: `services:
  ghost:
    image: ghost:5-alpine
    container_name: dockcontrol-ghost-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:2368"
    env_file:
      - .env
    environment:
      url: \${url:-http://localhost:__HOST_PORT__}
      NODE_ENV: \${NODE_ENV:-production}
    volumes:
      - ghost_data___INSTANCE_ID__:/var/lib/ghost/content
volumes:
  ghost_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  minio: {
    compose: `services:
  minio:
    image: minio/minio:latest
    container_name: dockcontrol-minio-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:9001"
      - "9000:9000"
    command: server /data --console-address ":9001"
    env_file:
      - .env
    environment:
      MINIO_ROOT_USER: \${MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD:-__RANDOM_PASSWORD__}
    volumes:
      - minio_data___INSTANCE_ID__:/data
volumes:
  minio_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  nextcloud: {
    compose: `services:
  nextcloud:
    image: nextcloud:latest
    container_name: dockcontrol-nextcloud-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:80"
    env_file:
      - .env
    volumes:
      - nextcloud_data___INSTANCE_ID__:/var/www/html
volumes:
  nextcloud_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  postgresql: {
    compose: `services:
  postgresql:
    image: postgres:16-alpine
    container_name: dockcontrol-postgresql-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:5432"
    env_file:
      - .env
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-dockcontrol}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-__RANDOM_PASSWORD__}
      POSTGRES_DB: \${POSTGRES_DB:-dockcontrol}
    volumes:
      - pg_data___INSTANCE_ID__:/var/lib/postgresql/data
volumes:
  pg_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  redis: {
    compose: `services:
  redis:
    image: redis:7-alpine
    container_name: dockcontrol-redis-app-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:6379"
    volumes:
      - redis_app_data___INSTANCE_ID__:/data
volumes:
  redis_app_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  mysql: {
    compose: `services:
  mysql:
    image: mysql:8
    container_name: dockcontrol-mysql-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:3306"
    env_file:
      - .env
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD:-__RANDOM_PASSWORD__}
      MYSQL_DATABASE: \${MYSQL_DATABASE:-app}
    volumes:
      - mysql_data___INSTANCE_ID__:/var/lib/mysql
volumes:
  mysql_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  mongodb: {
    compose: `services:
  mongodb:
    image: mongo:7
    container_name: dockcontrol-mongodb-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:27017"
    env_file:
      - .env
    environment:
      MONGO_INITDB_ROOT_USERNAME: \${MONGO_INITDB_ROOT_USERNAME:-dockcontrol}
      MONGO_INITDB_ROOT_PASSWORD: \${MONGO_INITDB_ROOT_PASSWORD:-__RANDOM_PASSWORD__}
    volumes:
      - mongo_data___INSTANCE_ID__:/data/db
volumes:
  mongo_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  gitea: {
    compose: `services:
  gitea:
    image: gitea/gitea:latest
    container_name: dockcontrol-gitea-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:3000"
    env_file:
      - .env
    environment:
      USER_UID: "1000"
      USER_GID: "1000"
    volumes:
      - gitea_data___INSTANCE_ID__:/data
volumes:
  gitea_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  vaultwarden: {
    compose: `services:
  vaultwarden:
    image: vaultwarden/server:latest
    container_name: dockcontrol-vaultwarden-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:80"
    env_file:
      - .env
    environment:
      WEBSOCKET_ENABLED: "true"
    volumes:
      - vw_data___INSTANCE_ID__:/data
volumes:
  vw_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  plausible: {
    compose: `services:
  plausible-db:
    image: postgres:15-alpine
    container_name: dockcontrol-plausible-db-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    environment:
      POSTGRES_PASSWORD: __RANDOM_PASSWORD__
    volumes:
      - plausible_db___INSTANCE_ID__:/var/lib/postgresql/data
  plausible-events:
    image: clickhouse/clickhouse-server:24.3-alpine
    container_name: dockcontrol-plausible-events-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    volumes:
      - plausible_events___INSTANCE_ID__:/var/lib/clickhouse
  plausible:
    image: ghcr.io/plausible/community-edition:v2.1.5
    container_name: dockcontrol-plausible-__INSTANCE_ID__
    restart: unless-stopped
    depends_on:
      - plausible-db
      - plausible-events
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:8000"
    env_file:
      - .env
    environment:
      BASE_URL: \${BASE_URL:-http://localhost:__HOST_PORT__}
      # Two concatenated 32-char random values = 64 chars, the minimum
      # Plausible accepts for SECRET_KEY_BASE.
      SECRET_KEY_BASE: \${SECRET_KEY_BASE:-__RANDOM_PASSWORD_2____RANDOM_PASSWORD_3__}
      # MUST match plausible-db's POSTGRES_PASSWORD (same placeholder →
      # same generated value). The previous hardcoded "plausible" password
      # never matched the random one the db got — install was dead on boot.
      # Hosts use the instance-suffixed container_name (unique on the
      # shared dockcontrol-apps network), not the bare service alias.
      DATABASE_URL: postgres://postgres:__RANDOM_PASSWORD__@dockcontrol-plausible-db-__INSTANCE_ID__:5432/plausible_db
      CLICKHOUSE_DATABASE_URL: http://dockcontrol-plausible-events-__INSTANCE_ID__:8123/plausible_events_db
volumes:
  plausible_db___INSTANCE_ID__:
  plausible_events___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  'code-server': {
    compose: `services:
  code-server:
    image: codercom/code-server:latest
    container_name: dockcontrol-code-server-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:8080"
    env_file:
      - .env
    environment:
      PASSWORD: \${PASSWORD:-__RANDOM_PASSWORD__}
    volumes:
      - code_data___INSTANCE_ID__:/home/coder
volumes:
  code_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  supabase: {
    compose: `services:
  supabase-studio:
    image: supabase/studio:latest
    container_name: dockcontrol-supabase-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:3000"
    environment:
      STUDIO_PG_META_URL: http://localhost:8080
networks:
  dockcontrol-apps:
    external: true`,
  },
  appwrite: {
    compose: `services:
  appwrite:
    image: appwrite/appwrite:1.6
    container_name: dockcontrol-appwrite-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:80"
    volumes:
      - appwrite_data___INSTANCE_ID__:/storage
volumes:
  appwrite_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },

  // ── Email & webmail apps ────────────────────────────────────────
  roundcube: {
    compose: `services:
  roundcube:
    image: roundcube/roundcubemail:latest
    container_name: dockcontrol-roundcube-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:80"
    environment:
      # \${VAR:-default} so a .env (DockControl's "install webmail" flow injects
      # the real mail host/ports) overrides the placeholder. Escaped here because
      # this is a JS template literal — the \$ stays literal in the YAML.
      ROUNDCUBEMAIL_DEFAULT_HOST: "\${ROUNDCUBEMAIL_DEFAULT_HOST:-tls://host.docker.internal}"
      ROUNDCUBEMAIL_DEFAULT_PORT: "\${ROUNDCUBEMAIL_DEFAULT_PORT:-993}"
      ROUNDCUBEMAIL_SMTP_SERVER: "\${ROUNDCUBEMAIL_SMTP_SERVER:-tls://host.docker.internal}"
      ROUNDCUBEMAIL_SMTP_PORT: "\${ROUNDCUBEMAIL_SMTP_PORT:-587}"
      ROUNDCUBEMAIL_DB_TYPE: sqlite
      ROUNDCUBEMAIL_UPLOAD_MAX_FILESIZE: 25M
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - roundcube_data___INSTANCE_ID__:/var/roundcube/db
      - roundcube_config___INSTANCE_ID__:/var/roundcube/config
      # Accept the mail server's self-signed cert on the INTERNAL docker link
      # (STARTTLS to dockcontrol-mail-<domain>). Host-only traffic, never public.
      - __HOST_APP_DIR__/roundcube-ssl.inc.php:/var/roundcube/config/dockcontrol-ssl.inc.php:ro
volumes:
  roundcube_data___INSTANCE_ID__:
  roundcube_config___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },

  snappymail: {
    compose: `services:
  snappymail:
    image: djmaze/snappymail:latest
    container_name: dockcontrol-snappymail-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:8888"
    volumes:
      - snappymail_data___INSTANCE_ID__:/var/lib/snappymail
volumes:
  snappymail_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },

  rainloop: {
    compose: `services:
  rainloop:
    image: hardware/rainloop:latest
    container_name: dockcontrol-rainloop-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:8888"
    volumes:
      - rainloop_data___INSTANCE_ID__:/rainloop/data
volumes:
  rainloop_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },

  mailpit: {
    compose: `services:
  mailpit:
    image: axllent/mailpit:latest
    container_name: dockcontrol-mailpit-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:8025"
      - "1025:1025"
    volumes:
      - mailpit_data___INSTANCE_ID__:/data
    environment:
      MP_DATA_FILE: /data/mailpit.db
      MP_MAX_MESSAGES: "5000"
volumes:
  mailpit_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },

  postal: {
    compose: `services:
  postal:
    image: ghcr.io/postalserver/postal:3
    container_name: dockcontrol-postal-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:5000"
      - "2526:25"
    volumes:
      - postal_data___INSTANCE_ID__:/opt/postal/storage
      - postal_config___INSTANCE_ID__:/config
    depends_on:
      - postal-mariadb
      - postal-rabbitmq
  postal-mariadb:
    image: mariadb:11
    container_name: dockcontrol-postal-mariadb-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    environment:
      MYSQL_ROOT_PASSWORD: __RANDOM_PASSWORD__
      MYSQL_DATABASE: postal
      MYSQL_USER: postal
      MYSQL_PASSWORD: __RANDOM_PASSWORD_2__
    volumes:
      - postal_db___INSTANCE_ID__:/var/lib/mysql
  postal-rabbitmq:
    image: rabbitmq:3-management
    container_name: dockcontrol-postal-rabbitmq-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    environment:
      RABBITMQ_DEFAULT_USER: postal
      RABBITMQ_DEFAULT_PASS: postal
volumes:
  postal_data___INSTANCE_ID__:
  postal_config___INSTANCE_ID__:
  postal_db___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },

  mailu: {
    compose: `# Mailu lite — only the webmail + admin parts. SMTP/IMAP are exposed by docker-mailserver.
services:
  mailu-admin:
    image: ghcr.io/mailu/admin:2024.06
    container_name: dockcontrol-mailu-admin-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:8080"
    environment:
      SECRET_KEY: "change-me-in-production"
      DOMAIN: mail.example.com
      SUBNET: 127.0.0.0/24
    volumes:
      - mailu_data___INSTANCE_ID__:/data
volumes:
  mailu_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  // PrestaShop ships its own auto-installer when PS_INSTALL_AUTO=1 and a
  // DB is reachable. We bundle a dedicated MariaDB instance so the user
  // just clicks Deploy and lands on a working back-office. Both services
  // get unique container names + volumes via __INSTANCE_ID__ so two
  // shops can coexist on the same host.
  prestashop: {
    compose: `services:
  prestashop:
    image: prestashop/prestashop:latest
    container_name: dockcontrol-prestashop-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:80"
    env_file:
      - .env
    environment:
      DB_SERVER: prestashop-db-__INSTANCE_ID__
      DB_USER: prestashop
      DB_PASSWD: __RANDOM_PASSWORD__
      DB_NAME: prestashop
      DB_PREFIX: ps_
      PS_INSTALL_AUTO: \${PS_INSTALL_AUTO:-1}
      PS_LANGUAGE: \${PS_LANGUAGE:-en}
      PS_COUNTRY: \${PS_COUNTRY:-FR}
      ADMIN_MAIL: \${ADMIN_MAIL:-admin@example.com}
      ADMIN_PASSWD: \${ADMIN_PASSWD:-__RANDOM_PASSWORD_3__}
      PS_DOMAIN: \${PS_DOMAIN:-}
      PS_ENABLE_SSL: 1
      PS_FOLDER_ADMIN: admin
      PS_FOLDER_INSTALL: install
    # Trust the Caddy reverse proxy. PrestaShop checks $_SERVER['HTTPS']
    # to decide whether to allow the admin login; behind Caddy the
    # container sees plain HTTP (Caddy terminates TLS). Without this
    # fix the user lands on "Pour des raisons de sécurité, vous ne
    # pouvez pas vous connecter tant que vous n'avez pas activé SSL".
    #
    # We mount a config drop-in into Apache's auto-loaded conf-enabled/
    # dir so the upstream HTTPS proto is mapped to HTTPS=on for PHP.
    # The file is written next to docker-compose.yml by the install
    # path. Keeping the image's stock entrypoint untouched is critical
    # — overriding it (we briefly did) broke the auto-installer.
    volumes:
      - prestashop_data___INSTANCE_ID__:/var/www/html
      # Bind mounts use the placeholder __HOST_APP_DIR__ instead of
      # relative paths. When the API runs in a container, docker compose
      # from inside it passes the compose-file directory to the host
      # daemon as the mount source -- but that directory only exists
      # inside the API container. The daemon resolves bind sources on
      # the HOST filesystem and finds nothing, creating an empty dir at
      # the mount point. The placeholder is replaced at install time
      # with DOCKCONTROL_HOST_DATA_DIR + the per-instance subpath, which
      # IS a real host path the daemon can resolve.
      - __HOST_APP_DIR__/prestashop-proxy.conf:/etc/apache2/conf-enabled/dockcontrol-proxy.conf:ro
      - __HOST_APP_DIR__/php-trust-proxy.ini:/usr/local/etc/php/conf.d/zzz-dockcontrol-trust-proxy.ini:ro
      - __HOST_APP_DIR__/dockcontrol-trust-proxy.php:/usr/local/etc/php/dockcontrol-trust-proxy.php:ro
    depends_on:
      prestashop-db-__INSTANCE_ID__:
        condition: service_healthy
  prestashop-db-__INSTANCE_ID__:
    image: mariadb:11
    container_name: dockcontrol-prestashop-db-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    environment:
      MARIADB_DATABASE: prestashop
      MARIADB_USER: prestashop
      MARIADB_PASSWORD: __RANDOM_PASSWORD__
      MARIADB_ROOT_PASSWORD: __RANDOM_PASSWORD_2__
    volumes:
      - prestashop_db___INSTANCE_ID__:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 10
volumes:
  prestashop_data___INSTANCE_ID__:
  prestashop_db___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  // Multi-DB modern web UI. Persistent data so saved connections survive
  // restarts. Attached to dockcontrol-apps so user-deployed DB containers
  // are reachable by container_name from inside.
  dbgate: {
    compose: `services:
  dbgate:
    image: dbgate/dbgate:latest
    container_name: dockcontrol-dbgate-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:3000"
    env_file:
      - .env
    volumes:
      - dbgate_data___INSTANCE_ID__:/root/.dbgate
volumes:
  dbgate_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  // Single-file PHP DB browser. No persistent state — login info kept
  // in browser session. ADMINER_DESIGN can theme it from .env.
  adminer: {
    compose: `services:
  adminer:
    image: adminer:latest
    container_name: dockcontrol-adminer-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:8080"
    env_file:
      - .env
networks:
  dockcontrol-apps:
    external: true`,
  },
  // phpMyAdmin — defaults to arbitrary mode (PMA_ARBITRARY=1) so the
  // user picks the server on the login screen. UPLOAD_LIMIT controls
  // the SQL import cap (PHP upload_max_filesize behind the scenes).
  phpmyadmin: {
    compose: `services:
  phpmyadmin:
    image: phpmyadmin:latest
    container_name: dockcontrol-phpmyadmin-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:80"
    env_file:
      - .env
networks:
  dockcontrol-apps:
    external: true`,
  },
  // pgAdmin — admin email + password are required env vars (the
  // dashboard's Advanced step enforces that). PGADMIN_LISTEN_PORT
  // overrides the in-container listen so we map it cleanly. Server
  // connections persist in the named volume.
  pgadmin: {
    compose: `services:
  pgadmin:
    image: dpage/pgadmin4:latest
    container_name: dockcontrol-pgadmin-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:80"
    env_file:
      - .env
    environment:
      PGADMIN_DEFAULT_EMAIL: \${PGADMIN_DEFAULT_EMAIL:-admin@example.com}
      PGADMIN_DEFAULT_PASSWORD: \${PGADMIN_DEFAULT_PASSWORD:-__RANDOM_PASSWORD__}
    volumes:
      - pgadmin_data___INSTANCE_ID__:/var/lib/pgadmin
volumes:
  pgadmin_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
  // mongo-express — ME_CONFIG_MONGODB_URL is required (the dashboard
  // marks it as required: true). Basic auth on the UI itself so the
  // browser admin isn't world-readable.
  'mongo-express': {
    compose: `services:
  mongo-express:
    image: mongo-express:latest
    container_name: dockcontrol-mongo-express-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:8081"
    env_file:
      - .env
    environment:
      ME_CONFIG_BASICAUTH: "true"
networks:
  dockcontrol-apps:
    external: true`,
  },
  // RedisInsight — Redis Inc's official GUI. Volume persists connection
  // entries so they survive a redeploy. Listens on the same internal
  // port we publish externally (no rewrite needed).
  redisinsight: {
    compose: `services:
  redisinsight:
    image: redis/redisinsight:latest
    container_name: dockcontrol-redisinsight-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:5540"
    env_file:
      - .env
    volumes:
      - redisinsight_data___INSTANCE_ID__:/data
volumes:
  redisinsight_data___INSTANCE_ID__:
networks:
  dockcontrol-apps:
    external: true`,
  },
};

/**
 * Companion files some templates need next to docker-compose.yml.
 * The marketplace install path writes each entry into the per-instance
 * appDir BEFORE running `docker compose up`, then the compose file
 * bind-mounts them into the container.
 *
 * Filenames must match the bind-mount path declared in the matching
 * COMPOSE_TEMPLATES entry. Adding a side file here without referencing
 * it in the compose body is a no-op.
 */
export const SIDE_FILES: Record<string, Record<string, string>> = {
  roundcube: {
    // Mounted at /var/roundcube/config/dockcontrol-ssl.inc.php — the Roundcube
    // image auto-includes every config*.inc.php. We connect to the mail server
    // over the INTERNAL docker network (dockcontrol-mail-<domain>) with STARTTLS,
    // whose cert is self-signed for that container name. The link never leaves
    // the host, so skipping peer verification is safe (same trust model as an
    // app talking to its DB by container_name).
    'roundcube-ssl.inc.php':
      `<?php
// Auto-generated by DockControl. Internal STARTTLS to the mail container —
// self-signed cert on a host-only docker link, so peer verification is off.
$ssl = ['ssl' => ['verify_peer' => false, 'verify_peer_name' => false, 'allow_self_signed' => true]];
$config['imap_conn_options'] = $ssl;
$config['smtp_conn_options'] = $ssl;
`,
  },
  prestashop: {
    // Mounted at /etc/apache2/conf-enabled/dockcontrol-proxy.conf so
    // Apache loads it on startup. Maps Caddy's X-Forwarded-Proto to
    // HTTPS=on for PHP and trusts internal docker subnets for the
    // real-client-IP rewrite.
    //
    // SetEnvIf alone is not enough — PrestaShop's `Tools::usingSecureMode()`
    // reads `$_SERVER['HTTPS']` directly from PHP, which Apache hands over
    // only when the *connection* was over TLS, not when an env var says so.
    // To bridge this we ALSO drop a PHP prepend file (below) that mutates
    // $_SERVER at request boot from the X-Forwarded-Proto header. The
    // Apache conf still helps third-party modules that read `getenv()`.
    'prestashop-proxy.conf':
      `# Auto-generated by DockControl marketplace install.
# SetEnvIf is part of mod_setenvif which is enabled by default on the
# prestashop image. We deliberately do NOT use mod_remoteip here:
# the PrestaShop image ships Apache without that module compiled in,
# and any RemoteIP* directive crashes the worker on boot. The PHP
# auto-prepend shim is what actually fixes the HTTPS detection — this
# conf just covers third-party modules that read getenv('HTTPS').
SetEnvIf X-Forwarded-Proto https HTTPS=on
`,
    // Mounted at /usr/local/etc/php/conf.d/zzz-dockcontrol-trust-proxy.ini
    // so the PHP image's docker-php-entrypoint picks it up. The `zzz-`
    // prefix ensures it loads AFTER any image-shipped PHP conf — last
    // writer wins on auto_prepend_file.
    'php-trust-proxy.ini':
      `; Auto-generated by DockControl marketplace install.
auto_prepend_file = /usr/local/etc/php/dockcontrol-trust-proxy.php
`,
    // The actual shim. Runs before every PHP request. Mirrors
    // \$_SERVER['HTTPS'] / SERVER_PORT / REQUEST_SCHEME from the
    // X-Forwarded-Proto header Caddy sets on every reverse_proxy block.
    // We only trust the header when REMOTE_ADDR is on a private
    // docker subnet — i.e. the request came from Caddy on the
    // dockcontrol-apps bridge, not from a direct public connection
    // bypassing the proxy.
    'dockcontrol-trust-proxy.php':
      `<?php
// Auto-generated by DockControl. Trust X-Forwarded-Proto from internal proxies.
if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO'])) {
    $remote = $_SERVER['REMOTE_ADDR'] ?? '';
    $internal = false;
    foreach (['10.', '172.', '192.168.', '127.'] as $prefix) {
        if (strpos($remote, $prefix) === 0) { $internal = true; break; }
    }
    if ($internal && strtolower($_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https') {
        $_SERVER['HTTPS'] = 'on';
        $_SERVER['SERVER_PORT'] = 443;
        $_SERVER['REQUEST_SCHEME'] = 'https';
    }
}
`,
  },
};

/**
 * Per-app env that pins the PUBLIC domain/URL for web apps that bake their
 * site address into their DB/config on first boot (and would otherwise
 * auto-detect it from the FIRST HTTP request's Host header — including the
 * container's own published `:port`, which then gets frozen into every
 * generated link forever).
 *
 * Applied ONLY in clean-URL mode: the app is served at https://<domain> on
 * Caddy's :443, so we hand the app the clean hostname up front. The result
 * is deterministic regardless of which path the first request takes.
 *
 * Returns {} for apps that don't persist a domain (plain DBs, DB GUIs,
 * dashboards like Portainer/Grafana that read the Host header live per
 * request). The caller merges this UNDER the user's form env — an explicit
 * value from the install dialog always wins.
 *
 * NOTE: the matching templates MUST declare `env_file: - .env` so these
 * vars actually reach the container (the install path writes them to .env).
 */
export function domainPinEnv(slug: string, domain: string): Record<string, string> {
  const https = `https://${domain}`;
  switch (slug) {
    case 'prestashop':
      // ps_shop_url / ps_shop_domain_ssl. PS_ENABLE_SSL is already 1 in the
      // template, so the shop serves https on the clean host.
      return { PS_DOMAIN: domain };
    case 'wordpress':
      // WordPress writes siteurl/home into wp_options on install. WP_HOME +
      // WP_SITEURL constants in wp-config.php OVERRIDE the DB values at
      // runtime, so the clean domain wins even if the install request came
      // in on host:port. Single line (no newlines) — the .env writer escapes
      // newlines and would corrupt the PHP otherwise.
      return {
        WORDPRESS_CONFIG_EXTRA: `define('WP_HOME','${https}'); define('WP_SITEURL','${https}');`,
      };
    case 'ghost':
      // Ghost's `url` is authoritative for every generated link (admin,
      // feeds, canonical tags). Setting it fixes all of them at once.
      return { url: https };
    case 'nextcloud':
      // TRUSTED_DOMAINS is mandatory — Nextcloud hard-refuses any host not in
      // the list ("Access through untrusted domain"). OVERWRITEHOST/PROTOCOL
      // make it generate https://<domain> links behind Caddy's TLS termination.
      return {
        NEXTCLOUD_TRUSTED_DOMAINS: domain,
        OVERWRITEHOST: domain,
        OVERWRITEPROTOCOL: 'https',
      };
    case 'gitea':
      // ROOT_URL is baked into app.ini on first boot; the GITEA__ env vars
      // re-assert it on every start so clone URLs / OAuth callbacks / webhooks
      // all use the clean host.
      return {
        GITEA__server__ROOT_URL: `${https}/`,
        GITEA__server__DOMAIN: domain,
      };
    default:
      return {};
  }
}

export const PORT_MAP: Record<string, number> = {
  // 9090, NOT 9000: minio's template hard-publishes 9000:9000 (S3 API), and
  // NOT 9443: that's an HTTPS-looking port — the dashboard would render an
  // https:// link to what is now a plain-HTTP container listener (9000).
  portainer: 9090,
  grafana: 3001,
  'uptime-kuma': 3002,
  n8n: 5678,
  wordpress: 8080,
  ghost: 2368,
  minio: 9001,
  nextcloud: 8081,
  postgresql: 5433,
  redis: 6380,
  mysql: 3306,
  mongodb: 27017,
  gitea: 3030,
  vaultwarden: 8085,
  plausible: 8086,
  'code-server': 8087,
  prestashop: 8090,
  dbgate: 3300,
  adminer: 8088,
  phpmyadmin: 8089,
  pgadmin: 5050,
  'mongo-express': 8091,
  redisinsight: 5540,
  supabase: 3003,
  appwrite: 8082,
  roundcube: 8083,
  snappymail: 8084,
  rainloop: 8085,
  // 8092: was 8086, which collided with plausible (both in the active
  // catalog) — installing the second one always failed with a 409
  // "Default port taken". Keep every ACTIVE catalog app on a unique
  // default. (rainloop/postal/mailu duplicates below are fine — those
  // apps are no longer in catalog.json.)
  mailpit: 8092,
  postal: 8087,
  mailu: 8088,
};

/**
 * Build a docker-compose body for an arbitrary Docker Hub image — no template
 * required. The dashboard's "Deploy custom image" dialog feeds this so users
 * can run literally any image without us pre-baking it into PORT_MAP.
 */
export function renderCustomComposeTemplate(opts: {
  image: string;
  containerPort: number;
  envVars?: Record<string, string>;
  volumes?: string[];
  command?: string;
}): string {
  const env = Object.entries(opts.envVars || {})
    .map(([k, v]) => `      ${k}: ${JSON.stringify(String(v))}`)
    .join('\n');
  // Defensive: never interpolate a volume raw. A newline or non-named-volume
  // spec would inject arbitrary compose keys (privileged, cap_add, pid:host)
  // or bind-mount the host fs. checkVolumeSafety() is the same guard the DTO
  // and service apply; re-run it here so a direct caller can't bypass it.
  for (const v of opts.volumes || []) {
    const err = checkVolumeSafety(v);
    if (err) throw new Error(`Unsafe volume: ${err}`);
  }
  // Quote each safe spec via JSON.stringify so it lands on exactly one line.
  const vols = (opts.volumes || []).map((v) => `      - ${JSON.stringify(v)}`).join('\n');
  const hasVolumes = (opts.volumes || []).length > 0;
  return `services:
  app:
    image: ${opts.image}
    container_name: dockcontrol-custom-__INSTANCE_ID__
    restart: unless-stopped
    networks:
      - dockcontrol-apps
    ports:
      - "__HOST_PORT__:${opts.containerPort}"
${opts.command ? `    command: ${JSON.stringify(opts.command)}\n` : ''}${env ? `    environment:\n${env}\n` : ''}${vols ? `    volumes:\n${vols}\n` : ''}${hasVolumes ? `volumes: {}\n` : ''}networks:
  dockcontrol-apps:
    external: true
`;
}
