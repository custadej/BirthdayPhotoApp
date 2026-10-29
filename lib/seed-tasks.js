'use strict';

/** Initial task list ("text | label"). Seeded into the DB once; edited in the admin afterwards. */
const SEED = `Slikaj nekoga, ki pleše | Slika nekoga, ki pleše
Slikaj slavljenca ali slavljenko | Slika slavljenca ali slavljenke
Slikaj slavljenca z družino | Slika slavljenca z družino
Selfie s slavljencem ali slavljenko | Selfie s slavljencem ali slavljenko
Slikaj se z osebo, ki jo najmanj poznaš | Selfie z osebo, ki jo najmanj poznam
Slikaj najbolj resnega človeka v dvorani | Slika najbolj resnega človeka v dvorani
Selfie s tremi ljudmi, ki jih še nisi slikal | Selfie s tremi novimi obrazi
Slikaj nekaj rdečega | Slika nečesa rdečega
Slikaj nekaj zlatega | Slika nečesa zlatega
Slikaj nekaj srebrnega | Slika nečesa srebrnega
Slikaj hrano na krožniku, preden jo pojeste | Slika hrane na krožniku
Slikaj najbolj okusno jed večera | Slika najbolj okusne jedi večera
Slikaj torto ali sladico | Slika torte ali sladice
Slikaj nekoga, ki se smeje | Slika nekoga, ki se smeje
Slikaj nekoga, ki se smeje do solz | Slika smeha do solz
Slikaj najbolj vesel obraz v dvorani | Slika najbolj veselega obraza
Selfie z natakarjem ali natakarico | Selfie z natakarjem ali natakarico
Slikaj najbolj elegantno obleko | Slika najbolj elegantne obleke
Slikaj dva človeka, ki se objemata | Slika dveh ljudi, ki se objemata
Slikaj nekoga, ki pripoveduje šalo | Slika nekoga, ki pripoveduje šalo
Slikaj glasbenike ali DJ-a | Slika glasbenikov ali DJ-a
Selfie z najstarejšim gostom | Selfie z najstarejšim gostom
Selfie z najmlajšim gostom | Selfie z najmlajšim gostom
Naredi najbolj smešen obraz in se slikaj | Najbolj smešen obraz večera
Naredi pozo kot na naslovnici revije in se slikaj | Naslovnica revije
Slikaj mizo, za katero sediš | Slika naše mize
Skupinska slika cele mize | Skupinska slika cele mize
Slikaj nekoga, ki dviguje kozarec | Slika nekoga, ki dviguje kozarec
Slikaj nazdravljanje | Slika nazdravljanja
Slikaj najlepšo dekoracijo v dvorani | Slika najlepše dekoracije
Slikaj najbolj nenavadno stvar v dvorani | Slika najbolj nenavadne stvari
Slikaj svoje čevlje | Slika mojih čevljev
Slikaj pogled iz dvorane | Pogled iz dvorane
Selfie z osebo, ki ima brado ali brke | Selfie z brado ali brki
Slikaj skupino, ki pozira kot pop zvezde | Slika pop zvezd večera
Slikaj nekoga, ki pleše bolje kot ti | Slika boljšega plesalca od mene
Selfie z novim znancem, ki ga še ne poznaš | Selfie z novim znancem`;

const SEED_TASKS = SEED.split('\n').map(line => {
  const [text, label] = line.split('|').map(s => s.trim());
  return { text, label: label || text };
});

module.exports = { SEED_TASKS };
