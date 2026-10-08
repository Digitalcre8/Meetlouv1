import { seedArmstrong } from './seed';

const result = await seedArmstrong();
// Identifiers and the routing address only. The local password is a constant in seed.ts.
console.log(
  JSON.stringify(
    {
      firm: { id: result.firm.id, name: result.firm.name, mailDomain: result.firm.mail_domain },
      feeEarner: { userId: result.feeEarner.userId, email: result.feeEarner.email },
      matter: {
        id: result.matter.id,
        reference: result.matter.reference,
        inboundSlug: result.matter.inbound_slug,
        inboundAddress: result.inboundAddress,
      },
      participants: [result.sarahWhitfield, result.priyaNandra].map((p) => ({
        id: p.id,
        displayName: p.display_name,
        access: p.access,
        role: p.role,
      })),
    },
    null,
    2,
  ),
);
