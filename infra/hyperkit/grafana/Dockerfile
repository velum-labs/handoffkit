ARG GRAFANA_VERSION=11.6.0
FROM grafana/grafana:${GRAFANA_VERSION}

ARG ATHENA_PLUGIN_VERSION=3.2.0
ARG XRAY_PLUGIN_VERSION=2.17.0
ARG BUSINESS_CHARTS_PLUGIN_VERSION=7.2.5

USER root

RUN grafana cli --pluginsDir /var/lib/grafana/plugins plugins install grafana-athena-datasource "${ATHENA_PLUGIN_VERSION}" \
    && grafana cli --pluginsDir /var/lib/grafana/plugins plugins install grafana-x-ray-datasource "${XRAY_PLUGIN_VERSION}" \
    && grafana cli --pluginsDir /var/lib/grafana/plugins plugins install volkovlabs-echarts-panel "${BUSINESS_CHARTS_PLUGIN_VERSION}"

COPY --chown=472:0 provisioning /etc/grafana/provisioning
COPY --chown=472:0 dashboards /var/lib/grafana/dashboards

USER 472
