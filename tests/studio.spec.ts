import { expect, test } from '@playwright/test';

/** Generated PCM tone: no licensed fixture or network audio dependency. */
function wavFile(durationSec = 12) {
  const rate = 8000;
  const samples = rate * durationSec;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(index * Math.PI * 2 * 220 / rate) * 1200), 44 + index * 2);
  }
  return { name: 'practice-tone.wav', mimeType: 'audio/wav', buffer };
}

test('loads local music, uses the audio clock, pauses, seeks, and restarts', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Find your rhythm.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play music', exact: true })).toBeDisabled();
  await page.getByLabel('Upload music file').setInputFiles(wavFile());
  await expect(page.getByRole('heading', { name: 'practice-tone.wav' })).toBeVisible();
  const position = page.getByRole('slider', { name: 'Song position' });
  await expect(position).toHaveAttribute('max', '12');

  await page.getByLabel('Tempo BPM').fill('100');
  await expect(page.getByLabel('Tempo BPM')).toHaveValue('100');
  await page.getByRole('button', { name: 'Play music', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause music', exact: true })).toBeVisible();
  await expect(page.getByLabel('Tempo BPM')).toBeDisabled();
  await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(0.8);
  await expect(page.locator('.beat.active')).toHaveCount(1);
  await expect.poll(async () => Number(await page.getByTestId('render-fps').textContent())).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Pause music', exact: true }).click();
  await expect(position).toBeEnabled();
  const paused = Number(await position.inputValue());
  await page.waitForTimeout(350);
  expect(Math.abs(Number(await position.inputValue()) - paused)).toBeLessThan(0.12);

  const range = await position.boundingBox();
  if (!range) throw new Error('The song position slider is not visible.');
  await position.click({ position: { x: range.width / 2, y: range.height / 2 } });
  await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(5.5);
  await expect.poll(async () => Number(await position.inputValue())).toBeLessThan(6.5);
  await page.getByRole('button', { name: 'Restart song and score' }).click();
  await expect.poll(async () => Number(await position.inputValue())).toBeLessThan(0.25);
  await expect(page.getByTestId('score')).toHaveText('0');
  expect(errors).toEqual([]);
});

test('camera permission failure is actionable and does not break practice', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => { throw new DOMException('Camera permission denied. Allow camera access in browser settings.', 'NotAllowedError'); },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Enable camera' }).click();
  await expect(page.getByRole('alert')).toContainText(/camera|permission/i);
  await expect(page.getByRole('button', { name: 'Enable camera' })).toBeEnabled();
  await page.getByLabel('Upload music file').setInputFiles(wavFile(2));
  await page.getByRole('button', { name: 'Play music', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible();
  await expect(page.getByTestId('score')).toHaveText('0');
  expect(errors).toEqual([]);
});

test('small screen keeps playback and timing controls reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Load a track' })).toBeVisible();
  await expect(page.getByLabel('Tempo BPM')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'How to play' }).click();
  await expect(page.getByRole('heading', { name: 'A little room. A lot of rhythm.' })).toBeVisible();
});
