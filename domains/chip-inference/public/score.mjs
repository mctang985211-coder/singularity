// Environment-owned score calculator for the local INT8 dot-product pilot.
//
// The formula is deliberately small and has no kernel-side counterpart:
//   latency_ns = cycles * critical_period_ns
//   quality    = exp(w_latency * ln(reference_latency_ns / latency_ns)
//                    + w_area    * ln(reference_area_um2 / area_um2))
//
// w_power is required to be zero: this environment has only default-activity
// OpenSTA power, which is diagnostic and cannot be called measured workload PPA.
// Nothing here rounds, clips, saturates or imputes a missing observation.

const finite = value => typeof value === 'number' && Number.isFinite(value)
const positive = (value, name) => {
  if (!finite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`)
  return value
}

export const WEIGHT_NAMES = Object.freeze(['latency', 'area', 'power'])

export function assertWeights(weights) {
  if (weights === null || typeof weights !== 'object' || Array.isArray(weights))
    throw new Error('weights must be an object with latency, area and power')
  for (const name of WEIGHT_NAMES) {
    if (!finite(weights[name]) || weights[name] < 0)
      throw new Error(`weight ${name} must be a nonnegative finite number`)
  }
  if (weights.power !== 0)
    throw new Error('power weight must stay 0: the only available power value has default activity and is not a measured workload PPA')
  if (weights.latency + weights.area <= 0)
    throw new Error('at least one of latency and area must carry positive weight')
  if (Math.abs(weights.latency + weights.area + weights.power - 1) > 1e-12)
    throw new Error('latency, area and power weights must sum to 1')
  return weights
}

export function contributions(observed, reference, weights) {
  assertWeights(weights)
  if (observed === null || typeof observed !== 'object')
    throw new Error('observed measurement must be an object')
  if (reference === null || typeof reference !== 'object')
    throw new Error('reference measurement must be an object')
  const cycles = positive(observed.cycles, 'observed.cycles')
  const period = positive(observed.critical_period_ns, 'observed.critical_period_ns')
  const area = positive(observed.area_um2, 'observed.area_um2')
  const referenceLatency = positive(reference.latency_ns, 'reference.latency_ns')
  const referenceArea = positive(reference.area_um2, 'reference.area_um2')
  const latency = cycles * period
  positive(latency, 'observed latency')
  const latencyRatio = referenceLatency / latency
  const areaRatio = referenceArea / area
  // Logs are the weighted contributions. Their sum is the log of the score;
  // exponentiating is the only transform, so the score stays positive and unbounded.
  const latencyContribution = weights.latency * Math.log(latencyRatio)
  const areaContribution = weights.area * Math.log(areaRatio)
  const logScore = latencyContribution + areaContribution
  const quality = Math.exp(logScore)
  if (!finite(quality) || quality <= 0) throw new Error('score is not a positive finite number')
  return Object.freeze({
    cycles, criticalPeriodNs: period, latencyNs: latency, areaUm2: area,
    referenceLatencyNs: referenceLatency, referenceAreaUm2: referenceArea,
    latencyRatio, areaRatio, latencyContribution, areaContribution, logScore, quality,
  })
}

export function calculate(observed, reference, weights) {
  return contributions(observed, reference, weights).quality
}
