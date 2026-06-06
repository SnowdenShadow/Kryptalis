// Marketplace compose templates.
//
// Every template uses these per-install placeholders so each install is
// isolated and the port the user picks is what actually binds on the host:
//
//   __HOST_PORT__   → the canonical host-side port (Application.port).
//                     Defaults to PORT_MAP[slug] when the user doesn't override.
//   __INSTANCE_ID__ → first 12 chars of Application.id. Used for container
//                     names AND volume namespaces so two instances of the
//                     same image can coexist on one host.
//
// For apps that expose a SECOND port (Portainer's 8000, Postal's SMTP 25,
// MinIO's S3 9000, etc.) we still hardcode that secondary port — the user
// changes the canonical port via the dashboard, and the second port is for
// advanced cases only (handled via Application.portMapping later).
export const COMPOSE_TEMPLATES: Record<string, { compose: string; healthCheck?: string }> = {
  portainer: {
    compose: `services:
  portainer:
    image: portainer/portainer-ce:lts
    container_name: kryptalis-portainer-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:9443"
      - "8000:8000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - portainer_data___INSTANCE_ID__:/data
volumes:
  portainer_data___INSTANCE_ID__:`,
  },
  grafana: {
    compose: `services:
  grafana:
    image: grafana/grafana:latest
    container_name: kryptalis-grafana-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:3000"
    volumes:
      - grafana_data___INSTANCE_ID__:/var/lib/grafana
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
volumes:
  grafana_data___INSTANCE_ID__:`,
  },
  'uptime-kuma': {
    compose: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    container_name: kryptalis-uptime-kuma-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:3001"
    volumes:
      - uptime_data___INSTANCE_ID__:/app/data
volumes:
  uptime_data___INSTANCE_ID__:`,
  },
  n8n: {
    compose: `services:
  n8n:
    image: n8nio/n8n:latest
    container_name: kryptalis-n8n-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:5678"
    volumes:
      - n8n_data___INSTANCE_ID__:/home/node/.n8n
    environment:
      - N8N_SECURE_COOKIE=false
volumes:
  n8n_data___INSTANCE_ID__:`,
  },
  wordpress: {
    compose: `services:
  wordpress:
    image: wordpress:latest
    container_name: kryptalis-wordpress-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:80"
    environment:
      WORDPRESS_DB_HOST: wordpress-db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: wordpress
      WORDPRESS_DB_NAME: wordpress
    volumes:
      - wp_data___INSTANCE_ID__:/var/www/html
    depends_on:
      - wordpress-db
  wordpress-db:
    image: mariadb:11
    container_name: kryptalis-wordpress-db-__INSTANCE_ID__
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: wordpress
      MYSQL_USER: wordpress
      MYSQL_PASSWORD: wordpress
      MYSQL_ROOT_PASSWORD: rootpassword
    volumes:
      - wp_db___INSTANCE_ID__:/var/lib/mysql
volumes:
  wp_data___INSTANCE_ID__:
  wp_db___INSTANCE_ID__:`,
  },
  ghost: {
    compose: `services:
  ghost:
    image: ghost:5-alpine
    container_name: kryptalis-ghost-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:2368"
    environment:
      url: http://localhost:__HOST_PORT__
    volumes:
      - ghost_data___INSTANCE_ID__:/var/lib/ghost/content
volumes:
  ghost_data___INSTANCE_ID__:`,
  },
  minio: {
    compose: `services:
  minio:
    image: minio/minio:latest
    container_name: kryptalis-minio-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:9001"
      - "9000:9000"
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - minio_data___INSTANCE_ID__:/data
volumes:
  minio_data___INSTANCE_ID__:`,
  },
  nextcloud: {
    compose: `services:
  nextcloud:
    image: nextcloud:latest
    container_name: kryptalis-nextcloud-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:80"
    volumes:
      - nextcloud_data___INSTANCE_ID__:/var/www/html
volumes:
  nextcloud_data___INSTANCE_ID__:`,
  },
  postgresql: {
    compose: `services:
  postgresql:
    image: postgres:16-alpine
    container_name: kryptalis-postgresql-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:5432"
    environment:
      POSTGRES_USER: kryptalis
      POSTGRES_PASSWORD: kryptalis
      POSTGRES_DB: kryptalis
    volumes:
      - pg_data___INSTANCE_ID__:/var/lib/postgresql/data
volumes:
  pg_data___INSTANCE_ID__:`,
  },
  redis: {
    compose: `services:
  redis:
    image: redis:7-alpine
    container_name: kryptalis-redis-app-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:6379"
    volumes:
      - redis_app_data___INSTANCE_ID__:/data
volumes:
  redis_app_data___INSTANCE_ID__:`,
  },
  supabase: {
    compose: `services:
  supabase-studio:
    image: supabase/studio:latest
    container_name: kryptalis-supabase-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:3000"
    environment:
      STUDIO_PG_META_URL: http://localhost:8080
volumes: {}`,
  },
  appwrite: {
    compose: `services:
  appwrite:
    image: appwrite/appwrite:1.6
    container_name: kryptalis-appwrite-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:80"
    volumes:
      - appwrite_data___INSTANCE_ID__:/storage
volumes:
  appwrite_data___INSTANCE_ID__:`,
  },

  // ── Email & webmail apps ────────────────────────────────────────
  roundcube: {
    compose: `services:
  roundcube:
    image: roundcube/roundcubemail:latest
    container_name: kryptalis-roundcube-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:80"
    environment:
      ROUNDCUBEMAIL_DEFAULT_HOST: tls://host.docker.internal
      ROUNDCUBEMAIL_DEFAULT_PORT: "993"
      ROUNDCUBEMAIL_SMTP_SERVER: tls://host.docker.internal
      ROUNDCUBEMAIL_SMTP_PORT: "587"
      ROUNDCUBEMAIL_DB_TYPE: sqlite
      ROUNDCUBEMAIL_UPLOAD_MAX_FILESIZE: 25M
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - roundcube_data___INSTANCE_ID__:/var/roundcube/db
      - roundcube_config___INSTANCE_ID__:/var/roundcube/config
volumes:
  roundcube_data___INSTANCE_ID__:
  roundcube_config___INSTANCE_ID__:`,
  },

  snappymail: {
    compose: `services:
  snappymail:
    image: djmaze/snappymail:latest
    container_name: kryptalis-snappymail-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:8888"
    volumes:
      - snappymail_data___INSTANCE_ID__:/var/lib/snappymail
volumes:
  snappymail_data___INSTANCE_ID__:`,
  },

  rainloop: {
    compose: `services:
  rainloop:
    image: hardware/rainloop:latest
    container_name: kryptalis-rainloop-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:8888"
    volumes:
      - rainloop_data___INSTANCE_ID__:/rainloop/data
volumes:
  rainloop_data___INSTANCE_ID__:`,
  },

  mailpit: {
    compose: `services:
  mailpit:
    image: axllent/mailpit:latest
    container_name: kryptalis-mailpit-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:8025"
      - "1025:1025"
    volumes:
      - mailpit_data___INSTANCE_ID__:/data
    environment:
      MP_DATA_FILE: /data/mailpit.db
      MP_MAX_MESSAGES: "5000"
volumes:
  mailpit_data___INSTANCE_ID__:`,
  },

  postal: {
    compose: `services:
  postal:
    image: ghcr.io/postalserver/postal:3
    container_name: kryptalis-postal-__INSTANCE_ID__
    restart: unless-stopped
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
    container_name: kryptalis-postal-mariadb-__INSTANCE_ID__
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: postal_root
      MYSQL_DATABASE: postal
      MYSQL_USER: postal
      MYSQL_PASSWORD: postal
    volumes:
      - postal_db___INSTANCE_ID__:/var/lib/mysql
  postal-rabbitmq:
    image: rabbitmq:3-management
    container_name: kryptalis-postal-rabbitmq-__INSTANCE_ID__
    restart: unless-stopped
    environment:
      RABBITMQ_DEFAULT_USER: postal
      RABBITMQ_DEFAULT_PASS: postal
volumes:
  postal_data___INSTANCE_ID__:
  postal_config___INSTANCE_ID__:
  postal_db___INSTANCE_ID__:`,
  },

  mailu: {
    compose: `# Mailu lite — only the webmail + admin parts. SMTP/IMAP are exposed by docker-mailserver.
services:
  mailu-admin:
    image: ghcr.io/mailu/admin:2024.06
    container_name: kryptalis-mailu-admin-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:8080"
    environment:
      SECRET_KEY: "change-me-in-production"
      DOMAIN: mail.example.com
      SUBNET: 127.0.0.0/24
    volumes:
      - mailu_data___INSTANCE_ID__:/data
volumes:
  mailu_data___INSTANCE_ID__:`,
  },
};

export const PORT_MAP: Record<string, number> = {
  portainer: 9443,
  grafana: 3001,
  'uptime-kuma': 3002,
  n8n: 5678,
  wordpress: 8080,
  ghost: 2368,
  minio: 9001,
  nextcloud: 8081,
  postgresql: 5433,
  redis: 6380,
  supabase: 3003,
  appwrite: 8082,
  roundcube: 8083,
  snappymail: 8084,
  rainloop: 8085,
  mailpit: 8086,
  postal: 8087,
  mailu: 8088,
};

/**
 * Build a docker-compose body for an arbitrary Docker Hub image — no template
 * required. The dashboard's "Deploy custom image" dialog feeds this so users
 * can run literally any image without us pre-baking it into PORT_MAP.
 *
 * Volumes are optional; pass them as `host:container` strings. Env vars are
 * inlined as `KEY: value` lines so secrets land in the env section (not the
 * shell expansion of `${KEY}` syntax).
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
  const vols = (opts.volumes || []).map((v) => `      - ${v}`).join('\n');
  const hasVolumes = (opts.volumes || []).length > 0;
  return `services:
  app:
    image: ${opts.image}
    container_name: kryptalis-custom-__INSTANCE_ID__
    restart: unless-stopped
    ports:
      - "__HOST_PORT__:${opts.containerPort}"
${opts.command ? `    command: ${JSON.stringify(opts.command)}\n` : ''}${env ? `    environment:\n${env}\n` : ''}${vols ? `    volumes:\n${vols}\n` : ''}${hasVolumes ? `volumes: {}\n` : ''}`;
}
