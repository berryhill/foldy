# Context MUST be a fresh staging directory, not the repository or a state root.
# Explicit immutable Node 24 base required; no floating default.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /opt/foldy
COPY --chown=0:0 dist/ ./dist/
COPY --chown=0:0 node_modules/ ./node_modules/
COPY --chown=0:0 bundle/ ./bundle/
RUN chmod -R a-w /opt/foldy && mkdir /data && chown 1000:1000 /data && chmod 700 /data
ENV NODE_ENV=production FOLDY_PORT=8080 FOLDY_BUNDLE_DIR=/opt/foldy/bundle FOLDY_STATE_DIR=/data
USER 1000:1000
EXPOSE 8080
# Mount /data explicitly; do not silently allocate an anonymous VOLUME.
# Root filesystem immutability is enforced by --read-only at launch.
ENTRYPOINT ["node", "--experimental-default-type=module", "dist/main.js"]
