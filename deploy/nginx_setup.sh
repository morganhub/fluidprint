# deploy/nginx_setup.sh — publie le conteneur fluidprint (127.0.0.1:18090) sur fluidprint.fluidifia.com.
# Idempotent. Lancer : fluiddeploy run deploy/nginx_setup.sh
# Le mot de passe est vérifié par l'application (FLUIDPRINT_PASSWORD du .env), pas par nginx.
[[ $EUID -eq 0 ]] || die "à lancer en root : fluiddeploy run sans --user"

HOST="fluidprint.fluidifia.com"
PORT=18090
VHOST_CONF="/var/www/vhosts/system/$HOST/conf/vhost_nginx.conf"

say "1/2 mode proxy Apache"
# Sans lui, nginx répond seul et transmet tout au conteneur (comme les autres sites Docker du serveur).
plesk bin domain --update-web-server-settings "$HOST" -nginx-proxy-mode false >/dev/null
note "désactivé"

say "2/2 directives nginx"
NEW_CONF="$(mktemp)"
cat > "$NEW_CONF" <<NGINX
# Géré par fluidprint deploy/nginx_setup.sh : modifier là-bas, pas dans Plesk.
location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # Photos jusqu'à 200 Mo ; import d'un design et export mesurés dans Chrome : réponses lentes.
        client_max_body_size 220m;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        add_header X-Robots-Tag "noindex, nofollow" always;
}
NGINX

if [[ -f "$VHOST_CONF" ]] && cmp -s "$NEW_CONF" "$VHOST_CONF"; then
    note "vhost_nginx.conf déjà à jour"
    rm -f "$NEW_CONF"
else
    # nginx sert tous les sites du serveur : valider avant d'appliquer, restaurer en cas d'échec.
    BACKUP=""
    if [[ -f "$VHOST_CONF" ]]; then BACKUP="$VHOST_CONF.bak-$(date +%s)"; cp -p "$VHOST_CONF" "$BACKUP"; fi
    install -m 644 "$NEW_CONF" "$VHOST_CONF"
    rm -f "$NEW_CONF"
    plesk sbin httpdmng --reconfigure-domain "$HOST" >/dev/null
    if ! nginx -t >/dev/null 2>&1; then
        if [[ -n "$BACKUP" ]]; then mv "$BACKUP" "$VHOST_CONF"; else rm -f "$VHOST_CONF"; fi
        plesk sbin httpdmng --reconfigure-domain "$HOST" >/dev/null
        die "configuration nginx invalide : ancienne configuration restaurée"
    fi
    [[ -n "$BACKUP" ]] && rm -f "$BACKUP"
    systemctl reload nginx
    note "vhost_nginx.conf appliqué, nginx rechargé"
fi

say "Terminé : https://$HOST"
