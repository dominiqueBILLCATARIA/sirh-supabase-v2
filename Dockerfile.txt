# On utilise une image Node.js officielle
FROM node:18

# ON INSTALLE LIBREOFFICE (Essentiel pour la conversion PDF)
RUN apt-get update && apt-get install -y libreoffice

# Créer le dossier de l'app
WORKDIR /usr/src/app

# Installer les dépendances
COPY package*.json ./
RUN npm install

# Copier le reste du code
COPY . .

# Port exposé
EXPOSE 4000

# Lancer le serveur
CMD [ "node", "server.js" ]
