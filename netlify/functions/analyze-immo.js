// analyze-immo.js — Netlify Function
// Fetch une annonce immobilière et extrait les données avec Claude

const ANTHROPIC_API_KEY = Netlify.env.get("ANTHROPIC_API_KEY");

// ── Helpers ───────────────────────────────────────────────────
const ok  = (data)  => new Response(JSON.stringify({ success: true,  data }), {
  status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
});
const err = (msg, status = 400) => new Response(JSON.stringify({ success: false, error: msg }), {
  status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
});

// ── Fetch URL content ─────────────────────────────────────────
async function fetchPageText(url) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
  };

  const resp = await fetch(url, { headers, redirect: "follow" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const html = await resp.text();

  // Extraire le texte brut — supprimer scripts, styles, nav
  const cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000); // Limiter pour l'API Claude

  return cleaned;
}

// ── Extract image from URL (for screenshot/visual sites) ──────
async function detectSite(url) {
  const u = url.toLowerCase();
  if (u.includes("seloger.com"))      return "seloger";
  if (u.includes("leboncoin.fr"))     return "leboncoin";
  if (u.includes("logic-immo.com"))   return "logic-immo";
  if (u.includes("bienici.com"))      return "bienici";
  if (u.includes("pap.fr"))           return "pap";
  if (u.includes("laforet.com"))      return "laforet";
  if (u.includes("century21.fr"))     return "century21";
  if (u.includes("orpi.com"))         return "orpi";
  if (u.includes("fnaim.fr"))         return "fnaim";
  if (u.includes("meilleursagents"))  return "meilleursagents";
  return "autre";
}

// ── Call Claude to extract data ───────────────────────────────
async function extractWithClaude(text, url, imageBase64, imageMediaType) {
  const site = await detectSite(url || "");

  const systemPrompt = `Tu es un expert immobilier français. Tu analyses des annonces immobilières et extrais les données structurées.
Tu réponds UNIQUEMENT avec un JSON valide, sans markdown ni explication.
Si une information n'est pas trouvée, utilise null.
Sois précis sur les surfaces (loi Carrez si mentionné), les prix (prix net vendeur sans les frais d'agence si possible), et le DPE.`;

  const userPrompt = `Analyse cette annonce immobilière${site !== "autre" ? ` de ${site}` : ""} et extrais toutes les données.

Texte de l'annonce :
${text}

Retourne UNIQUEMENT ce JSON (sans texte autour) :
{
  "prix_affiche": <nombre entier en euros, sans espace ni €>,
  "prix_hors_honoraires": <prix net vendeur si mentionné, sinon null>,
  "honoraires_pct": <pourcentage honoraires agence si mentionné, sinon null>,
  "surface": <surface en m² loi Carrez ou habitable, nombre décimal>,
  "surface_terrain": <surface terrain si maison, sinon null>,
  "nb_pieces": <nombre de pièces principales>,
  "nb_chambres": <nombre de chambres, null si non précisé>,
  "type_bien": <"appartement" | "maison" | "immeuble" | "studio" | "loft" | "autre">,
  "annee_construction": <année ou null>,
  "etage": <numéro d'étage ou null>,
  "nb_etages_immeuble": <nombre total d'étages de l'immeuble ou null>,
  "ville": <ville>,
  "code_postal": <code postal 5 chiffres ou null>,
  "arrondissement": <arrondissement si Paris/Lyon/Marseille, sinon null>,
  "quartier": <nom du quartier si mentionné, sinon null>,
  "dpe_lettre": <"A"|"B"|"C"|"D"|"E"|"F"|"G" ou null>,
  "ges_lettre": <"A"|"B"|"C"|"D"|"E"|"F"|"G" ou null>,
  "dpe_valeur_kwh": <valeur en kWh/m²/an si mentionnée, sinon null>,
  "loyer_actuel": <loyer mensuel actuel si bien loué, sinon null>,
  "loyer_potentiel": <loyer estimé ou mentionné, sinon null>,
  "charges_mensuelles": <charges mensuelles copropriété si mentionnées, sinon null>,
  "taxe_fonciere": <taxe foncière annuelle si mentionnée, sinon null>,
  "ascenseur": <true|false|null>,
  "parking": <true|false|null>,
  "cave": <true|false|null>,
  "balcon_terrasse": <true|false|null>,
  "gardien": <true|false|null>,
  "meuble": <true|false|null>,
  "chauffage_type": <"individuel gaz"|"individuel électrique"|"collectif gaz"|"collectif fioul"|"pompe à chaleur"|"autre" ou null>,
  "description_courte": <résumé de 1 phrase des points clés>,
  "points_forts": <tableau de 3 points forts maximum>,
  "points_faibles": <tableau de 3 points d'attention ou risques maximum>,
  "loyer_estime_bas": <fourchette basse du loyer de marché estimé selon la ville/surface, entier>,
  "loyer_estime_haut": <fourchette haute du loyer de marché estimé selon la ville/surface, entier>
}`;

  const messages = [];

  if (imageBase64 && imageMediaType) {
    // Vision mode — screenshot ou DPE
    messages.push({
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: imageMediaType, data: imageBase64 }
        },
        { type: "text", text: userPrompt }
      ]
    });
  } else {
    messages.push({ role: "user", content: userPrompt });
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      max_tokens: 1500,
      system: systemPrompt,
      messages
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const result = await response.json();
  const text_out = result.content?.[0]?.text || "";

  // Parse JSON — chercher entre accolades
  const jsonMatch = text_out.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Claude n'a pas retourné de JSON valide");

  return JSON.parse(jsonMatch[0]);
}

// ── Main handler ──────────────────────────────────────────────
export default async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  if (req.method !== "POST") return err("Méthode non autorisée", 405);

  if (!ANTHROPIC_API_KEY) return err("Clé API Anthropic manquante — configurez ANTHROPIC_API_KEY dans Netlify", 500);

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return err("Body JSON invalide");
  }

  const { type, url, base64, mediaType } = body;

  try {
    let pageText = "";
    let imageB64 = null;
    let imageMedia = null;

    if (type === "url" && url) {
      // Valider l'URL
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        return err("URL invalide");
      }

      // Sécurité : n'autoriser que les domaines immobiliers connus
      const ALLOWED_DOMAINS = [
        "seloger.com", "leboncoin.fr", "logic-immo.com", "bienici.com",
        "pap.fr", "laforet.com", "century21.fr", "orpi.com", "fnaim.fr",
        "meilleursagents.com", "explorimmo.com", "ouestfrance-immo.com",
        "guyhoquet.com", "era.fr", "stéphane-plaza.com", "immonot.com",
        "notaires.fr", "paruvendu.fr", "annoncesjaunes.fr",
        "rightmove.co.uk", "immobilier.lefigaro.fr", "particulier.fr"
      ];

      const hostname = parsedUrl.hostname.replace(/^www\./, "");
      const isAllowed = ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith("." + d));

      if (!isAllowed) {
        // Permettre quand même mais logger
        console.warn(`Domaine non listé : ${hostname}`);
      }

      try {
        pageText = await fetchPageText(url);
      } catch (fetchErr) {
        // Si le fetch échoue (ex: anti-bot), essayer avec juste l'URL dans le prompt
        console.warn("Fetch failed:", fetchErr.message);
        pageText = `URL de l'annonce : ${url}\n[Contenu non accessible - analyser uniquement depuis l'URL]`;
      }

    } else if (type === "image" && base64) {
      imageB64 = base64;
      imageMedia = mediaType || "image/jpeg";
      pageText = "Analyse l'image fournie.";

    } else {
      return err("Type requis : 'url' ou 'image'");
    }

    const data = await extractWithClaude(pageText, url || "", imageB64, imageMedia);
    return ok(data);

  } catch (e) {
    console.error("analyze-immo error:", e);
    return err(`Erreur d'analyse : ${e.message}`, 500);
  }
};

export const config = {
  path: "/api/analyze-immo"
};
