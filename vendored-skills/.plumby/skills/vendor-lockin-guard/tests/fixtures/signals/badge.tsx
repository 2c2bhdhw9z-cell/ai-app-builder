// MED signal: injected badge / watermark / feedback components.
// Includes the exactly-named forms that the old regex missed (M31 regression pin).
export function Footer() {
  return (
    <div>
      <Badge />
      <PoweredBy />
      <Watermark />
      <VendorBadge />
      <AcmeWatermark />
    </div>
  );
}
