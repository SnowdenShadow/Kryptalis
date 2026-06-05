export const COMPOSE_TEMPLATES: Record<string, { compose: string; healthCheck?: string }> = {
  portainer: {
    compose: `services:
  portainer:
    image: portainer/portainer-ce:lts
    container_name: kryptalis-portainer
    restart: unless-stopped
    ports:
      - "9443:9443"
      - "8000:8000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - portainer_data:/data
volumes:
  portainer_data:`,
  },
  grafana: {
    compose: `services:
  grafana:
    image: grafana/grafana:latest
    container_name: kryptalis-grafana
    restart: unless-stopped
    ports:
      - "3001:3000"
    volumes:
      - grafana_data:/var/lib/grafana
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
volumes:
  grafana_data:`,
  },
  'uptime-kuma': {
    compose: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    container_name: kryptalis-uptime-kuma
    restart: unless-stopped
    ports:
      - "3002:3001"
    volumes:
      - uptime_data:/app/data
volumes:
  uptime_data:`,
  },
  n8n: {
    compose: `services:
  n8n:
    image: n8nio/n8n:latest
    container_name: kryptalis-n8n
    restart: unless-stopped
    ports:
      - "5678:5678"
    volumes:
      - n8n_data:/home/node/.n8n
    environment:
      - N8N_SECURE_COOKIE=false
volumes:
  n8n_data:`,
  },
  wordpress: {
    compose: `services:
  wordpress:
    image: wordpress:latest
    container_name: kryptalis-wordpress
    restart: unless-stopped
    ports:
      - "8080:80"
    environment:
      WORDPRESS_DB_HOST: wordpress-db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: wordpress
      WORDPRESS_DB_NAME: wordpress
    volumes:
      - wp_data:/var/www/html
    depends_on:
      - wordpress-db
  wordpress-db:
    image: mariadb:11
    container_name: kryptalis-wordpress-db
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: wordpress
      MYSQL_USER: wordpress
      MYSQL_PASSWORD: wordpress
      MYSQL_ROOT_PASSWORD: rootpassword
    volumes:
      - wp_db:/var/lib/mysql
volumes:
  wp_data:
  wp_db:`,
  },
  ghost: {
    compose: `services:
  ghost:
    image: ghost:5-alpine
    container_name: kryptalis-ghost
    restart: unless-stopped
    ports:
      - "2368:2368"
    environment:
      url: http://localhost:2368
    volumes:
      - ghost_data:/var/lib/ghost/content
volumes:
  ghost_data:`,
  },
  minio: {
    compose: `services:
  minio:
    image: minio/minio:latest
    container_name: kryptalis-minio
    restart: unless-stopped
    ports:
      - "9000:9000"
      - "9001:9001"
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - minio_data:/data
volumes:
  minio_data:`,
  },
  nextcloud: {
    compose: `services:
  nextcloud:
    image: nextcloud:latest
    container_name: kryptalis-nextcloud
    restart: unless-stopped
    ports:
      - "8081:80"
    volumes:
      - nextcloud_data:/var/www/html
volumes:
  nextcloud_data:`,
  },
  postgresql: {
    compose: `services:
  postgresql:
    image: postgres:16-alpine
    container_name: kryptalis-postgresql
    restart: unless-stopped
    ports:
      - "5433:5432"
    environment:
      POSTGRES_USER: kryptalis
      POSTGRES_PASSWORD: kryptalis
      POSTGRES_DB: kryptalis
    volumes:
      - pg_data:/var/lib/postgresql/data
volumes:
  pg_data:`,
  },
  redis: {
    compose: `services:
  redis:
    image: redis:7-alpine
    container_name: kryptalis-redis-app
    restart: unless-stopped
    ports:
      - "6380:6379"
    volumes:
      - redis_app_data:/data
volumes:
  redis_app_data:`,
  },
  supabase: {
    compose: `services:
  supabase-studio:
    image: supabase/studio:latest
    container_name: kryptalis-supabase
    restart: unless-stopped
    ports:
      - "3003:3000"
    environment:
      STUDIO_PG_META_URL: http://localhost:8080
volumes: {}`,
  },
  appwrite: {
    compose: `services:
  appwrite:
    image: appwrite/appwrite:1.6
    container_name: kryptalis-appwrite
    restart: unless-stopped
    ports:
      - "8082:80"
    volumes:
      - appwrite_data:/storage
volumes:
  appwrite_data:`,
  },

  // ── Email & webmail apps ────────────────────────────────────────
  roundcube: {
    compose: `services:
  roundcube:
    image: roundcube/roundcubemail:latest
    container_name: kryptalis-roundcube
    restart: unless-stopped
    ports:
      - "8083:80"
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
      - roundcube_data:/var/roundcube/db
      - roundcube_config:/var/roundcube/config
volumes:
  roundcube_data:
  roundcube_config:`,
  },

  snappymail: {
    compose: `services:
  snappymail:
    image: djmaze/snappymail:latest
    container_name: kryptalis-snappymail
    restart: unless-stopped
    ports:
      - "8084:8888"
    volumes:
      - snappymail_data:/var/lib/snappymail
volumes:
  snappymail_data:`,
  },

  rainloop: {
    compose: `services:
  rainloop:
    image: hardware/rainloop:latest
    container_name: kryptalis-rainloop
    restart: unless-stopped
    ports:
      - "8085:8888"
    volumes:
      - rainloop_data:/rainloop/data
volumes:
  rainloop_data:`,
  },

  mailpit: {
    compose: `services:
  mailpit:
    image: axllent/mailpit:latest
    container_name: kryptalis-mailpit
    restart: unless-stopped
    ports:
      - "8086:8025"
      - "1025:1025"
    volumes:
      - mailpit_data:/data
    environment:
      MP_DATA_FILE: /data/mailpit.db
      MP_MAX_MESSAGES: "5000"
volumes:
  mailpit_data:`,
  },

  postal: {
    compose: `services:
  postal:
    image: ghcr.io/postalserver/postal:3
    container_name: kryptalis-postal
    restart: unless-stopped
    ports:
      - "8087:5000"
      - "2526:25"
    volumes:
      - postal_data:/opt/postal/storage
      - postal_config:/config
    depends_on:
      - postal-mariadb
      - postal-rabbitmq
  postal-mariadb:
    image: mariadb:11
    container_name: kryptalis-postal-mariadb
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: postal_root
      MYSQL_DATABASE: postal
      MYSQL_USER: postal
      MYSQL_PASSWORD: postal
    volumes:
      - postal_db:/var/lib/mysql
  postal-rabbitmq:
    image: rabbitmq:3-management
    container_name: kryptalis-postal-rabbitmq
    restart: unless-stopped
    environment:
      RABBITMQ_DEFAULT_USER: postal
      RABBITMQ_DEFAULT_PASS: postal
volumes:
  postal_data:
  postal_config:
  postal_db:`,
  },

  // Mailcow is too heavy for an in-process install; we keep it as a link only
  // (the user should follow the official mailcow-dockerized guide).

  mailu: {
    compose: `# Mailu lite — only the webmail + admin parts. SMTP/IMAP are exposed by docker-mailserver.
services:
  mailu-admin:
    image: ghcr.io/mailu/admin:2024.06
    container_name: kryptalis-mailu-admin
    restart: unless-stopped
    ports:
      - "8088:8080"
    environment:
      SECRET_KEY: "change-me-in-production"
      DOMAIN: mail.example.com
      SUBNET: 127.0.0.0/24
    volumes:
      - mailu_data:/data
volumes:
  mailu_data:`,
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
