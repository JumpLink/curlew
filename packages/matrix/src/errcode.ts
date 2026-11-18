/** The homeserver's `errcode`, or null when the body is not a Matrix error. */
export async function errcodeOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { errcode?: unknown };
    return typeof body.errcode === 'string' ? body.errcode : null;
  } catch {
    return null;
  }
}
