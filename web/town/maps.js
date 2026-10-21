import { RESIDENTS } from './client.js';

// Map identity is independent of Main/session identity. Only place and navigation change.
export const MAPS = Object.freeze({
  station: Object.freeze({ id: 'station', name: '樱花车站', caption: '桜ヶ丘 / SAKURAGAOKA', arrival: '穿过樱花，马上就到。', residents: RESIDENTS }),
  suibo: Object.freeze({ id: 'suibo', name: '穗波市', caption: '穗波 / SUIBO CITY', arrival: '沿着紫藤花，走进穗波。', residents: RESIDENTS.map(r => Object.freeze({ ...r,
    place: '穗波市 · 列车长咖啡厅内', groundHint: .35, patrol: { x0: 28, x1: 43, z0: 55.6, z1: 66 },
    ...(r.id === 'main-elaina' ? { x: 35.5, z: 58.2, subtitle: '咖啡厅里 · 灰之魔女' }
      : r.id === 'main-aemeath' ? { x: 36.8, z: 62, subtitle: '咖啡厅里 · 众光航标' }
        : { x: 35.1, z: 56.3 }),
  })) }),
});
export const mapFor = id => typeof id === 'string' && Object.hasOwn(MAPS, id) ? MAPS[id] : MAPS.station;
export function initialMap(search, storage) {
  const requested = new URLSearchParams(search).get('map');
  if (requested) return mapFor(requested);
  try { return mapFor(storage?.getItem('harbour-town-map')); } catch { return MAPS.station; }
}
