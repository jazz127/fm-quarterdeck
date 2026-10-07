// Opt-in wire representation: preserve every occurrence/order while transmitting
// identical message objects only once. Legacy /api/lanes remains unchanged.
export function compactLanes(lanes) {
  const messages = [], indices = new Map();
  return {
    format: "refs.v1",
    lanes: lanes.map((lane) => ({ ...lane, messages: lane.messages.map((message) => {
      const key = JSON.stringify(message);
      if (!indices.has(key)) {
        indices.set(key, messages.length);
        messages.push(message);
      }
      return indices.get(key);
    }) })),
    messages,
  };
}
