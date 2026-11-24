# Kart-Rennen mit zwölf Controllern

`npm run test:12-handys` startet einen eigenen lokalen Spielraum. Zwölf Socket.IO-Clients treten über den normalen Handy-Einstieg bei, bestätigen die Aufwärmrunde und fahren mit Tipp-Gas und Lenkung. Die schnelleren Karts warten ab der zweiten Runde, bis das ganze Feld die Runde erreicht. So bleibt nach der längsten Unterbrechung genug Zeit zum Aufholen.

## Messung vom 24. November 2026

Auf der Strandpromenade erreichten alle zwölf Karts das Ziel. Drei Clients trennten ihre Verbindung gleichzeitig für 2, 10 und 60 Sekunden. Bei der Rückkehr blieben Spieler-ID, Name, Farbe, Avatar und Renninstanz erhalten. Jeder der drei fuhr nach einem neuen Gastipp eine weitere Runde. Alle zwölf erhielten die gleiche Ergebnisliste.

| Messgröße | Ergebnis |
| --- | ---: |
| Messdauer im Rennen | 93,31 s |
| Spielzustände am durchgehend verbundenen Referenzhandy | 1.811 |
| Spielzustände pro Sekunde am Referenzhandy | 19,40 |
| Größe eines Spielzustands, Median | 4.640 Byte |
| Größe eines Spielzustands, 95. Perzentil | 4.723 Byte |
| Größter Spielzustand | 5.709 Byte |
| Empfangene Spielzustände über alle zwölf Clients | 20.341 |

Gemessen wurde die UTF-8-Größe der JSON-Nutzdaten des `state`-Ereignisses während des Rennens. Die Werte gelten für diesen Lauf auf der Loopback-Schnittstelle. WLAN-Strecke, Transport-Overhead und reale Handys brauchen eine separate Messung. Die Testentscheidung beruht auf Spielverlauf und Ergebnis. Größen und Raten werden bei jedem Lauf neu ausgegeben.
