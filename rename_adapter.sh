#!/bin/bash

OLD_NAME="smartloadmanager"
NEW_NAME="smartloadmanager"

echo "Ersetze alle Vorkommen von '$OLD_NAME' mit '$NEW_NAME' im aktuellen Verzeichnis..."

# Ersetzt im Dateinamen (Vorsicht, nicht immer nötig)
find . -depth -name "*$OLD_NAME*" | while read fname; do
  newname=$(echo "$fname" | sed "s/$OLD_NAME/$NEW_NAME/g")
  echo "Umbenennen: $fname -> $newname"
  git mv "$fname" "$newname"
done

# Ersetzt im Inhalt aller Dateien (nur Textdateien)
grep -rl --exclude-dir=.git "$OLD_NAME" . | while read file; do
  echo "Bearbeite Datei: $file"
  sed -i "s/$OLD_NAME/$NEW_NAME/g" "$file"
done

echo "Fertig!"
