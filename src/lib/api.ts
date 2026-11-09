import { getActiveApiProfile } from './apiProfiles'
import { composeMarkupDataUrl, toApiInputImageDataUrl } from './canvasImage'
import { callGardenImageApi } from './gardenImageApi'
import type { CallApiOptions, CallApiResult } from './imageApiShared'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const inputImageDataUrls = await Promise.all(opts.inputImageDataUrls.map(toApiInputImageDataUrl))
  if (opts.markupDataUrl && inputImageDataUrls.length) {
    inputImageDataUrls[0] = await composeMarkupDataUrl(inputImageDataUrls[0], opts.markupDataUrl)
  }
  opts.onPromptHintsPrepared?.(undefined)
  return callGardenImageApi({ ...opts, inputImageDataUrls }, getActiveApiProfile(opts.settings))
}
