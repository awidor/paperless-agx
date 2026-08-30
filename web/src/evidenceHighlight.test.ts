import { matchesEvidence } from "./evidenceHighlight";

if (!matchesEvidence("The Allianz policy renews in May", "…policy renews in May…")) throw new Error("phrase match failed");
if (!matchesEvidence("Allianz", "The Allianz policy renews in May")) throw new Error("embedded PDF word match failed");
if (matchesEvidence("Invoice total", "The Allianz policy renews in May")) throw new Error("unrelated text matched");
