/**
 * Library-neutral adapter for BailingHub's trusted widget renderer registry.
 *
 * `createChart` is supplied by the host application. It can wrap ECharts,
 * GPT-Vis, another chart library, or an internal reporting component.
 */
export function registerBailingChartRenderer(createChart) {
  if (typeof createChart !== 'function') {
    throw new TypeError('createChart must be a function');
  }
  if (!window.BailingChat || typeof window.BailingChat.registerRenderer !== 'function') {
    throw new Error('BailingHub widget renderer API is not available');
  }

  return window.BailingChat.registerRenderer({
    type: 'bailing-chart',
    version: 1,
    label: 'Business chart',
    contentType: 'application/json',
    maxPayloadBytes: 64 * 1024,
    mount({ container, payload, theme, signal }) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new TypeError('chart payload must be an object');
      }
      if (typeof payload.kind !== 'string' || !Array.isArray(payload.data)) {
        throw new TypeError('chart payload requires kind and data');
      }

      const chart = createChart(container, {
        spec: payload,
        accent: theme.accent,
      });
      let disposed = false;
      const destroy = () => {
        if (disposed) return;
        disposed = true;
        if (chart && typeof chart.destroy === 'function') chart.destroy();
        container.replaceChildren();
      };
      signal.addEventListener('abort', destroy, { once: true });
      return destroy;
    },
  });
}
