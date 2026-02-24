require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const supabase = require('./supabaseClient');
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const ImageModule = require('docxtemplater-image-module-free');
const sizeOf = require('image-size');
const libre = require('libreoffice-convert');
const { promisify } = require('util');
const convertAsync = promisify(libre.convert);
const axios = require('axios');
const SIGNATURE_PLACEHOLDER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAABAAQMAAAB6pZ9hAAAABlBMVEX///9BQUFE6v9pAAAAAXRSTlMAQObYZgAAADxJREFUeF7t0CERAAAIAzH86Bv7m8MEpInZ7mYpSUn6pCTpSUnSk5KkJyVJT0qSnpQkPSlJelKS9KQk6UmfBy68B9Vv999FAAAAAElFTkSuQmCC"; 
// Note : Tu peux créer ta propre petite image PNG "ZONE DE SIGNATURE" et la convertir en base64 si tu préfères un design spécifique.


// Fonction pour calculer la date de fin (Date début + nombre de jours)
const getEndDate = (startDate, days) => {
    if (!startDate || !days) return null;
    const date = new Date(startDate);
    date.setDate(date.getDate() + parseInt(days));
    return date.toISOString().split('T')[0]; // Renvoie format YYYY-MM-DD
};


async function isTargetAuthorized(requester, targetId) {
    // 1. Si le demandeur est ADMIN ou RH, il a tous les droits
    if (requester.permissions?.can_see_employees) return true;

    // 2. Si c'est l'utilisateur lui-même qui agit sur son propre compte
    if (String(requester.emp_id) === String(targetId)) return true;

    // 3. Sinon, on vérifie dans la base de données
    const { data: target } = await supabase
        .from('employees')
        .select('id, hierarchy_path, departement')
        .eq('id', targetId)
        .maybeSingle();

    if (!target) return false;

    // A. Est-ce que la cible est dans ma lignée descendante ?
    const isUnderMe = target.hierarchy_path?.startsWith(requester.hierarchy_path + '/');
    
    // B. Est-ce que la cible est dans mon Scope (Département) ?
    const isInMyScope = requester.management_scope?.includes(target.departement);

    return isUnderMe || isInMyScope;
}

// Fonction pour vérifier une permission spécifique
function checkPerm(req, permissionName) {
    return req.user && req.user.permissions && req.user.permissions[permissionName] === true;
}

// Fonction utilitaire pour calculer la distance (Formule de Haversine)
function getDistanceInMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Rayon de la terre en mètres
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// ... Tes require existants ...
const app = express();
      const upload = multer({
    limits: {
        fileSize: 5 * 1024 * 1024, // Limite à 5 Mo maximum par fichier
    },
    fileFilter: (req, file, cb) => {
        // Liste des formats pro autorisés
        const allowedTypes = [
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
            'application/pdf',
            'image/jpeg',
            'image/png'
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            // Si un pirate envoie un fichier .exe ou .js, il est bloqué ici
            cb(new Error('Format refusé. Seuls les DOCX, PDF, JPG et PNG sont autorisés.'));
        }
    }
});









async function sendEmailAPI(toEmail, subject, htmlContent) {
    try {
        await axios.post('https://api.brevo.com/v3/smtp/email', {
            sender: { name: "SIRH SECURE", email: "nevillebouchard98@gmail.com" }, 
            to: [{ email: toEmail }],
            subject: subject,
            htmlContent: htmlContent
        }, {
            headers: {
                'api-key': (process.env.BREVO_API_KEY || "").trim(),
                'Content-Type': 'application/json'
            }
        });
        console.log(`✅ Mail envoyé avec succès à ${toEmail}`);
        return true;
    } catch (error) {
        console.error("❌ Échec envoi API Brevo:", error.response ? error.response.data : error.message);
        return false;
    }
}






// Fonction pour vérifier si un module est actif
async function isModuleActive(moduleKey) {
    const { data } = await supabase
        .from('company_modules')
        .select('is_active')
        .eq('module_key', moduleKey)
        .single();
    return data ? data.is_active : false; // Par défaut false si pas trouvé
}



// ====================================================

app.use(cors());
// ... la suite de ton code ...
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    console.error("❌ ERREUR CRITIQUE : JWT_SECRET n'est pas configuré.");
    process.exit(1); // Le serveur s'arrête immédiatement si la clé n'est pas là
}

// --- MIDDLEWARE DE SÉCURITÉ JWT ---
const authenticateToken = (req, res, next) => {
    const action = req.params.action;
    
    // Ajout des deux actions de mot de passe oublié dans la liste publique
    const publicActions = [
        'login', 
        'gatekeeper', 
        'ingest-candidate', 
        'request-password-reset', 
        'reset-password'
    ];
    
    if (publicActions.includes(action)) return next(); 

    // On cherche le token soit dans le header, soit dans l'URL
    const authHeader = req.headers['authorization'];
    let token = authHeader && authHeader.split(' ')[1];
    if (!token && req.query.token) token = req.query.token;

    if (!token) {
        return res.status(401).json({ error: "Token manquant" });
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: "Session expirée" }); // 401 = Expiré
        
        // SECURITÉ : On s'assure que decoded.permissions existe toujours
        req.user = {
            ...decoded,
            permissions: decoded.permissions || {}
        };
        next();
    });
};









// Activer la protection sur toutes les routes /api/
app.use('/api/:action', authenticateToken);

// --- ROUTEUR CENTRAL ---
app.all('/api/:action', upload.any(), async (req, res) => {
    const action = req.params.action;
    console.log(`📥 Action reçue : [${action}]`);

    try {


// 1. LOGIN SÉCURISÉ (AVEC BLOCAGE DES SORTANTS)
        if (action === 'login') {
            const username = req.body.u || req.query.u;
            const password = req.body.p || req.query.p;

            // Récupération de l'utilisateur et de son rôle
            const { data: user, error } = await supabase
                .from('app_users')
                .select('id, email, password, nom_complet, employees(id, role, photo_url, statut, employee_type)') 
                .eq('email', username)
                .single();

            // VÉRIFICATION 1 : Identifiants corrects ?
            if (error || !user || user.password !== password) {
                return res.json({ status: "error", message: "Identifiants incorrects" });
            }

            const emp = (user.employees && user.employees.length > 0) ? user.employees[0] : null;

            // VÉRIFICATION 2 : Est-ce un compte orphelin ? (Sauf si Admin système)
            if (!emp && username !== 'admin@tondomaine.com') { 
                 return res.json({ status: "error", message: "Compte utilisateur non lié à une fiche employé" });
            }

            // VÉRIFICATION 3 : LE "KILL SWITCH" (C'est ici qu'on bloque les virés)
            if (emp) {
                const statut = (emp.statut || '').trim(); // On nettoie les espaces
                // On vérifie si le statut contient "Sortie" (ex: "Sortie", "Sortie Définitive", etc.)
                if (statut.toLowerCase().includes('sortie')) {
                    console.warn(`⛔ Tentative de connexion bloquée pour ${user.nom_complet} (Statut: ${statut})`);
                    return res.json({ status: "error", message: "Accès révoqué. Votre contrat est marqué comme terminé." });
                }
            }

            const userRole = emp ? (emp.role || 'EMPLOYEE').toUpperCase().trim() : 'EMPLOYEE';

            // --- RÉCUPÉRATION DES DROITS ---
            const { data: perms } = await supabase
                .from('role_permissions')
                .select('*')
                .eq('role_name', userRole)
                .single();

            const token = jwt.sign({ 
                id: user.id, 
                emp_id: emp ? emp.id : null, 
                role: userRole,
                permissions: perms || {},
                // On ajoute le path et le scope pour les filtres managers
                hierarchy_path: emp ? emp.hierarchy_path : null,
                management_scope: emp ? emp.management_scope : []
            }, JWT_SECRET, { expiresIn: '8h' }); // Expire dans 8h

            return res.json({
                status: "success",
                token: token,
                id: emp ? emp.id : null,
                nom: user.nom_complet,
                role: userRole,
                photo: emp ? emp.photo_url : null,
                employee_type: emp ? emp.employee_type : 'OFFICE', // Important pour le frontend
                permissions: perms || {}
            });
        }



        else if (action === 'delete-visit-report') {
            const { id } = req.body;
            // On ne supprime pas, on cache pour le manager
            const { error } = await supabase.from('visit_reports')
                .update({ hidden_for_manager: true })
                .eq('id', id);
            if (error) throw error;
            return res.json({ status: "success" });
        }

        // MASQUER UN BILAN JOURNALIER (ACTION CHEF)
        else if (action === 'delete-daily-report') {
            const { id } = req.body;
            const { error } = await supabase.from('daily_reports')
                .update({ hidden_for_manager: true })
                .eq('id', id);
            if (error) throw error;
            return res.json({ status: "success" });
        }






    
else if (action === 'read') {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10; 
    const offset = (page - 1) * limit;
    
    const search = req.query.search || '';
    const status = req.query.status || 'all';
    const type = req.query.type || 'all';
    const dept = req.query.dept || 'all';
    const targetId = req.query.target_id || ''; 

    try {
        const currentUserId = req.user.emp_id;

        const { data: requester } = await supabase.from('employees')
            .select('hierarchy_path, management_scope')
            .eq('id', currentUserId)
            .single();

 if (targetId) {
            if (!checkPerm(req, 'can_see_employees')) {
                // CORRECTION MAJEURE : Si l'utilisateur demande à voir SON PROPRE profil, on le laisse passer immédiatement
                if (String(targetId) === String(currentUserId)) {
                    // Accès autorisé à soi-même
                } else {
                    let idorQuery = supabase.from('employees').select('id').eq('id', targetId);
                    let idorConditions = [];
                    
                    // On vérifie que la hiérarchie existe avant de l'interroger
                    if (requester && requester.hierarchy_path) {
                        idorConditions.push(`hierarchy_path.ilike.${requester.hierarchy_path}/%`);
                    }
                    
                    if (requester && requester.management_scope?.length > 0) {
                        const scopeList = `(${requester.management_scope.map(s => `"${s}"`).join(',')})`;
                        idorConditions.push(`departement.in.${scopeList}`); 
                    }

                    if (idorConditions.length > 0) {
                        const { data: checkAccess } = await idorQuery.or(idorConditions.join(',')).maybeSingle();
                        if (!checkAccess) {
                            return res.status(403).json({ error: "Accès refusé : Profil hors périmètre." });
                        }
                    } else {
                        return res.status(403).json({ error: "Accès refusé : Aucun périmètre défini." });
                    }
                }
            }
        }

        // ============================================================
        // 🛡️ PHASE 5 : SÉCURITÉ DES COLONNES SENSIBLES (SALAIRES)
        // ============================================================
        // Liste des colonnes autorisées pour tous
        let columns = "id, nom, matricule, poste, departement, statut, role, photo_url, employee_type, date_embauche, type_contrat, solde_conges, hierarchy_path, management_scope, manager_id, date_naissance, email, telephone, adresse, contract_status, contrat_pdf_url, cv_url, id_card_url, diploma_url, attestation_url, lm_url";        
        // On ajoute les colonnes financières UNIQUEMENT si l'utilisateur a le droit "Paie"
        if (checkPerm(req, 'can_see_payroll')) {
            columns += ", salaire_brut_fixe, indemnite_transport, indemnite_logement";
        }

        let query = supabase.from('employees').select(columns, { count: 'exact' });
        // ============================================================

        if (checkPerm(req, 'can_see_employees')) {
            // Voit tout
        }
        else if (req.user.role === 'MANAGER' && requester) {
            let conditions = [];
            const myPath = requester.hierarchy_path;
            conditions.push(`hierarchy_path.eq.${myPath}`);
            conditions.push(`hierarchy_path.ilike.${myPath}/%`);

            if (requester.management_scope?.length > 0) {
                const scopeList = `(${requester.management_scope.map(s => `"${s}"`).join(',')})`;
                conditions.push(`departement.in.${scopeList}`);
            }
            query = query.or(conditions.join(','));
        }
        else {
            query = query.eq('id', currentUserId);
        }
        
        if (targetId) query = query.eq('id', targetId);
        if (search) query = query.or(`nom.ilike.%${search}%,matricule.ilike.%${search}%`);
        if (status !== 'all') {
            if (status === 'Actif') {
                // On demande au serveur les gens qui sont soit "Actif" soit "En Poste"
                query = query.in('statut', ['Actif', 'En Poste']);
            } else {
                query = query.eq('statut', status);
            }
        }  if (type !== 'all') query = query.eq('employee_type', type);
        if (dept !== 'all') query = query.eq('departement', dept);

        const { data, error, count } = await query
            .order('nom', { ascending: true })
            .range(offset, offset + limit - 1);

        if (error) throw error;
        return res.json({ data, meta: { total: count, page: page, last_page: Math.ceil(count / limit) } });

    } catch (err) { return res.status(500).json({ error: err.message }); }
}







                

        // 3. CONFIGURATION GPS (OUVERT À TOUS POUR LE POINTAGE)
        else if (action === 'read-config') {

            // CORRECTION : On retire la vérification de permission 'can_manage_config'.
            // Tout utilisateur connecté doit pouvoir connaître les zones pour calculer sa distance.
            
            const { data, error } = await supabase
                .from('zones')
                .select('*')
                .eq('actif', true);

            if (error) throw error;

            const mapped = data.map(z => ({
                Nom: z.nom,
                Latitude: z.latitude,
                Longitude: z.longitude,
                Rayon: z.rayon
            }));
            return res.json(mapped);
        }



            // --- AUDIT LOGS (PAGINÉ) ---
else if (action === 'read-logs') {
    if (!checkPerm(req, 'can_see_audit')) {
        return res.status(403).json({ error: "Accès refusé à l'Audit" });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = 20; // On affiche 20 logs par page
    const offset = (page - 1) * limit;

    try {
        const { data, error, count } = await supabase
            .from('logs')
            .select('*', { count: 'exact' }) // Demande le nombre total pour la pagination
            .order('created_at', { ascending: false }) // Les plus récents en premier
            .range(offset, offset + limit - 1); // La clé de la pagination

        if (error) throw error;

        return res.json({
            data: data,
            meta: {
                total: count,
                page: page,
                last_page: Math.ceil(count / limit)
            }
        });
    } catch (err) {
        console.error("Erreur read-logs:", err.message);
        return res.status(500).json({ error: err.message });
    }
}



        // ============================================================
        // 7. LECTURE DES CANDIDATURES (ATS) ✅
        // ============================================================
        else if (action === 'read-candidates') {

            if (!await isModuleActive('MOD_RECRUITMENT')) {
                return res.status(404).json({ error: "Module Recrutement désactivé." });
            }
          
                if (!checkPerm(req, 'can_see_recruitment')) {
                    return res.status(403).json({ error: "Accès refusé au Recrutement" });
                }
            console.log("📂 Lecture des candidatures Supabase...");
            const { data, error } = await supabase
                .from('candidatures')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.json(data);
        }







        

        // ============================================================
        // 12. GÉNÉRATION DE BADGE (TEMPLATE MAKE ADAPTÉ) ✅
        // ============================================================
else if (action === 'badge') {
            const { id } = req.query;
            if (!req.user) return res.status(401).send("Non connecté");

            const isMe = String(req.user.emp_id) === String(id);
            const canSeeOthers = req.user.permissions && req.user.permissions.can_see_employees;

            if (!isMe && !canSeeOthers) {
                return res.status(403).send("Accès refusé.");
            }

            const { data: emp, error } = await supabase.from('employees').select('*').eq('id', id).single();
            if (error || !emp) return res.status(404).send("Employé non trouvé.");

            // Préparation des variables calculées pour le CSS et les initiales
            const initials = emp.nom ? emp.nom.substring(0, 2).toUpperCase() : "??";
            const statusClass = (emp.statut || "").toLowerCase() === "actif" ? "status-actif" : "";

            // Template HTML Original de Make
            const htmlBadge = `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <title>Access Card - ${emp.nom}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;600;800&display=swap');
        
        body {
            margin: 0; padding: 0;
            background-color: #f3f4f6;
            font-family: 'Inter', sans-serif;
            display: flex; justify-content: center; align-items: center;
            height: 100vh;
            -webkit-print-color-adjust: exact;
        }

        .card-container {
            width: 320px; 
            min-height: 580px;
            background: white;
            border-radius: 24px;
            overflow: hidden;
            box-shadow: 0 20px 40px rgba(0,0,0,0.15);
            position: relative;
            border: 1px solid #e2e8f0;
            text-align: center;
            display: flex;
            flex-direction: column;
        }

        .header-bg {
            height: 140px;
            background: linear-gradient(135deg, #1e293b 0%, #3b82f6 100%);
            position: relative;
            flex-shrink: 0;
        }
        
        .company-name {
            color: white; font-weight: 800; letter-spacing: 2px; padding-top: 20px;
            font-size: 14px; opacity: 0.9; text-transform: uppercase;
        }

        .avatar-container {
            width: 130px; height: 130px; background: white; border-radius: 50%; padding: 5px;
            margin: -65px auto 15px auto; position: relative;
            box-shadow: 0 4px 10px rgba(0,0,0,0.1);
            display: flex; align-items: center; justify-content: center;
            overflow: hidden;
            flex-shrink: 0;
            z-index: 10;
        }
        
        .avatar { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; background-color: #f1f5f9; }

        .initials-box {
            width: 100%; height: 100%; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            background: #1e293b; color: white; font-size: 45px; font-weight: 800;
        }

        .name { font-size: 20px; font-weight: 800; color: #1e293b; margin: 0 20px; line-height: 1.2; text-transform: uppercase; }
        .role { color: #3b82f6; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin-top: 5px; margin-bottom: 8px; }
        
        .status-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 10px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 15px;
            background: #f1f5f9;
            color: #64748b;
            border: 1px solid #e2e8f0;
        }

        .status-actif {
            background: #dcfce7;
            color: #15803d;
            border: 1px solid #bbf7d0;
        }

        .divider { height: 2px; width: 40px; background: #e2e8f0; margin: 0 auto 15px auto; }

        .qr-box {
            background: #f8fafc; border: 1px dashed #cbd5e1;
            display: inline-block; padding: 8px; border-radius: 12px;
            margin-bottom: 10px;
        }
        
        .qr-img { width: 110px; height: 110px; display: block; }

        .footer-info { 
            margin-top: auto; 
            padding-bottom: 20px; 
            font-size: 10px; 
            color: #94a3b8; 
        }
        
        .id-pill {
            background: #1e293b; color: white; padding: 4px 12px; border-radius: 6px;
            font-size: 12px; font-weight: bold; display: inline-block; margin-top: 5px; font-family: monospace;
        }
    </style>
</head>
<body>

    <div class="card-container">
        <div class="header-bg"><div class="company-name">SIRH-SECURE</div></div>

        <div class="avatar-container">
            <img id="user-photo" src="" class="avatar" style="display:none;">
            <div id="user-initials" class="initials-box">
                ${initials}
            </div>
        </div>

        <div class="name">${emp.nom}</div>
        <div class="role">${emp.poste || ''}</div>
        
        <div>
            <span class="status-badge ${statusClass}">
                ● ${emp.statut || 'Actif'}
            </span>
        </div>

        <div class="divider"></div>

        <div>
            <div class="qr-box">
            <img class="qr-img" src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=https://sirh-secure-backend.onrender.com/api/gatekeeper?id=${emp.id}">            </div>
        </div>

        <div class="footer-info">
            MATRICULE OFFICIEL<br>
            <div class="id-pill">${emp.matricule}</div>
        </div>
    </div>

    <script>
        (function() {
            const rawUrl = "${emp.photo_url || ''}";
            const img = document.getElementById('user-photo');
            const initials = document.getElementById('user-initials');
            let finalUrl = "";

            if (rawUrl && rawUrl.includes("drive.google.com")) {
                const parts = rawUrl.split(/\\/(?:d|open|file\\/d|id=)\\/([a-zA-Z0-9_-]+)/);
                const fileId = parts[1] || rawUrl.split("id=")[1];
                if (fileId) {
                    finalUrl = "https://lh3.googleusercontent.com/d/" + fileId.split('&')[0];
                }
            } else if (rawUrl && rawUrl.startsWith("http")) {
                finalUrl = rawUrl;
            }

            if (finalUrl) {
                img.src = finalUrl;
                img.onload = function() {
                    img.style.display = "block";
                    initials.style.display = "none";
                    setTimeout(() => { window.print(); }, 800);
                };
                img.onerror = function() {
                    img.style.display = "none";
                    initials.style.display = "flex";
                    setTimeout(() => { window.print(); }, 800);
                };
            } else {
                setTimeout(() => { window.print(); }, 800);
            }
        })();
    </script>

</body>
</html>`;

            return res.send(htmlBadge);
        }









        // ============================================================
        // 15. GATEKEEPER : SCAN INTERNE VS SCAN PUBLIC (AVEC TEXTES EMAILS) ✅
        // ============================================================
        else if (action === 'gatekeeper') {
            const { id, key } = req.query;
            const SCAN_KEY = "SIGD_SECURE_2025";

            // 1. Récupérer l'employé
            const { data: emp, error } = await supabase
                .from('employees')
                .select('*')
                .eq('id', id)
                .single();

            if (error || !emp) return res.status(404).send("Badge invalide ou inconnu.");

            const isSortie = (emp.statut || "").toLowerCase().includes("sortie");

            // --------------------------------------------------------
            // CAS A : SCAN DEPUIS L'APP (TERMINAL SÉCURISÉ)
            // --------------------------------------------------------
            if (key === SCAN_KEY) {
                if (isSortie) {
                    console.log(`🚫 Accès Refusé (Statut Sortie) : ${emp.nom}`);
                    return res.json({
                        status: "REFUSÉ",
                        nom: `MATRICULE:${emp.id}----NOM:${emp.nom}----STATUT: ACCÈS REFUSÉ (DÉPART DÉFINITIF)`,
                        poste: emp.poste
                    });
                }

                console.log(`📱 Accès Autorisé : ${emp.nom}`);
                return res.json({
                    status: "valid",
                    nom: `MATRICULE:${emp.id}----NOM:${emp.nom}----POSTE :${emp.poste}----NUMERO:${emp.telephone}----ADRESSE:${emp.adresse}---- STATUT:${emp.statut}----DATE SCANNE:${new Date().toLocaleString()}`,
                    poste: emp.poste
                });
            }

            // --------------------------------------------------------
            // CAS B : SCAN PUBLIC (TÉLÉPHONE EXTERNE)
            // --------------------------------------------------------
            else {
                console.log(`🚨 Scan Public détecté pour : ${emp.nom}`);

                const nowStr = new Date().toLocaleString('fr-FR');

                // --- EMAIL POUR L'ADMIN (LOG DE SÉCURITÉ) ---
                const adminMail = {
                    from: `"Sécurité SIRH" <${process.env.SMTP_USER}>`,
                    to: "nevillebouchard98@gmail.com",
                    subject: `LOG DE SÉCURITÉ - CONSULTATION DE PROFIL - ${emp.nom}`,
                    text: `LOG DE SÉCURITÉ - CONSULTATION DE PROFIL

Bonjour,

Le profil numérique lié au badge suivant vient d'être consulté via un terminal mobile (hors réseau de pointage officiel)

Détails du badge consulté :
👤 Employé : ${emp.nom}
🆔 ID : ${emp.matricule}
💼 Poste : ${emp.poste}
📍 Site : Zogbo

Détails de l'accès :
📅 Date/Heure : ${nowStr}
🌐 Méthode : Scan QR Code (Portail Public)

Action recommandée :
Veuillez contacter l'employé pour confirmer la restitution du badge et vérifier si une désactivation temporaire des accès est nécessaire.

Ce message est envoyé pour assurer la traçabilité des consultations d'identité en dehors des terminaux de l'entreprise.`
                };

                // --- EMAIL POUR L'EMPLOYÉ ---
                const employeeMail = {
                    from: `"Service Sécurité - SIRH SECURE" <${process.env.SMTP_USER}>`,
                    to: emp.email,
                    subject: `Votre badge professionnel a été scanné`,
                    text: `SERVICE SÉCURITÉ - SIRH SECURE

Bonjour ${emp.nom},

Nous vous informons que votre badge professionnel (ID: ${emp.id}) a été scanné et signalé comme "Retrouvé" par une tierce personne le ${nowStr}.

Si vous avez toujours votre badge en votre possession :
Il s'agit probablement d'un test ou d'une erreur. Vous n'avez rien à faire.

Si vous avez perdu votre badge :
Restez joignable sur votre numéro (${emp.telephone}).
Une personne de la sécurité ou des RH va vous contacter sous peu.

Présentez-vous à l'accueil de l'agence Zogbo dès que possible.

Ceci est un message pour la protection de vos accès, un message est aussi envoyé aux administrateurs.`
                };

                try {

                    await sendEmailAPI("nevillebouchard98@gmail.com", adminMail.subject, adminMail.text);
                    await sendEmailAPI(emp.email, employeeMail.subject, employeeMail.text);



                } catch (e) { console.error("Erreur mails sécurité:", e.message); }

                // Log d'audit
                await supabase.from('logs').insert([{ agent: 'PORTAIL_PUBLIC', action: 'SCAN_EXTERNE', details: `Badge ${emp.nom} scanné par un tiers.` }]);

                // Page HTML de retour (Ton template de validation)
                return res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Validation de Badge - ${emp.nom}</title>
    <style>
        :root { --brand-color: #2563eb; --bg-light: #f1f5f9; --text-main: #1e293b; --text-muted: #64748b; }
        body { font-family: sans-serif; background-color: var(--bg-light); margin: 0; padding: 20px; color: var(--text-main); display: flex; justify-content: center; }
        .card { max-width: 420px; width: 100%; background: white; border-radius: 24px; box-shadow: 0 15px 35px rgba(0,0,0,0.1); overflow: hidden; border: 1px solid #e2e8f0; }
        .company-header { background: var(--brand-color); color: white; padding: 20px; text-align: center; font-weight: 800; text-transform: uppercase; }
        .profile-area { text-align: center; padding: 30px 20px 20px; }
        .avatar { width: 130px; height: 130px; background: #f8fafc; border-radius: 50%; margin: 0 auto 15px; border: 4px solid white; box-shadow: 0 4px 10px rgba(0,0,0,0.1); overflow: hidden; }
        .avatar img { width: 100%; height: 100%; object-fit: cover; }
        .name { font-size: 22px; font-weight: 700; margin: 0; }
        .info-section { background: #f8fafc; margin: 0 25px 25px; padding: 20px; border-radius: 16px; }
        .info-row { display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 14px; }
        .lost-found { padding: 20px 25px; border-top: 1px solid #f1f5f9; text-align: center; }
        .btn { display: block; width: 100%; padding: 14px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 14px; margin-bottom: 10px; border: none; }
        .btn-call { background: var(--brand-color); color: white; }
        .btn-report { background: #fff1f2; color: #be123c; border: 1px solid #fecdd3; }
    </style>
</head>
<body>
<div class="card">
    <div class="company-header">SIRH- SECURE</div>
    <div class="profile-area">
        <div class="avatar"><img src="${emp.photo_url || 'https://ui-avatars.com/api/?name='+emp.nom}" alt="Photo"></div>
        <h1 class="name">${emp.nom}</h1>
        <div style="color:var(--brand-color); font-weight:600;">${emp.poste}</div>
    </div>
    <div class="info-section">
        <div class="info-row"><span>ID Employé :</span><strong>${emp.id}</strong></div>
        <div class="info-row"><span>Département :</span><strong>${emp.departement}</strong></div>
        <div class="info-row"><span>Statut :</span><strong style="color: #059669;">Badge Vérifié ✓</strong></div>
    </div>
    <div class="lost-found">
        <p><strong>Vous avez trouvé ce badge ?</strong><br>Merci de nous contacter pour le restituer.</p>
        <a href="tel:+2290154978999" class="btn btn-call">📞 Appeler l'entreprise</a>
        <button class="btn btn-report" onclick="alert('Signalement transmis aux administrateurs.')">⚠️ Signaler comme PERDU</button>
    </div>
</div>
</body>
</html>`);
            }
        }



// --- LISTER LES MODÈLES (Pour le formulaire d'embauche) ---
else if (action === 'list-templates') {
    const { data, error } = await supabase
        .from('contract_templates')
        .select('*')
        .eq('is_active', true) // <--- Crucial : on ne propose que les modèles actuels
        .order('label', { ascending: true });

    if (error) throw error;
    return res.json(data);
}

// --- UPLOADER UN NOUVEAU MODÈLE DOCX ---
else if (action === 'upload-template') {
    if (!checkPerm(req, 'can_manage_config')) return res.status(403).json({ error: "Accès refusé." });
    
    const { role_target, label } = req.body;
    const file = req.files[0]; // Le fichier Word

    if (!role_target || !file) return res.status(400).json({ error: "Infos manquantes" });

    // 1. Upload du fichier dans le bucket 'documents'
    const fileName = `template_${role_target}_${Date.now()}.docx`;
    const { error: upErr } = await supabase.storage
        .from('documents')
        .upload(fileName, file.buffer, { contentType: file.mimetype });

    if (upErr) throw upErr;
    
    // 2. Récupération de l'URL publique
    const { data } = supabase.storage.from('documents').getPublicUrl(fileName);
    
    // 3. Enregistrement en base (Upsert pour mettre à jour si le rôle existe déjà)
    const { error: dbErr } = await supabase.from('contract_templates').upsert({
        role_target: role_target,
        label: label,
        template_file_url: data.publicUrl,
        is_active: true
    }, { onConflict: 'role_target' });

    if (dbErr) throw dbErr;

    return res.json({ status: "success" });
}

    



// --- GÉNÉRATION DU BROUILLON PDF (PRÉVISUALISATION) ---
else if (action === 'contract-gen') {
    if (!checkPerm(req, 'can_see_employees')) {
        return res.status(403).json({ error: "Accès refusé." });
    }

    const { id } = req.query;

    try {
        // 1. Récupération des données
        const { data: emp, error } = await supabase.from('employees').select('*').eq('id', id).single();
        if (error || !emp) throw new Error("Employé introuvable");

        // 2. RECHERCHE INTELLIGENTE DU MODÈLE (CORRECTIONS)
        let templateData = null;

        // Tentative A : Par l'ID technique du modèle (si sélectionné à la création)
        if (emp.contract_template_id) {
            const { data: byId } = await supabase.from('contract_templates')
                .select('template_file_url')
                .eq('id', emp.contract_template_id)
                .maybeSingle();
            templateData = byId;
        }

        // Tentative B : Par le Rôle si A n'a rien donné
        if (!templateData) {
            const { data: byRole } = await supabase.from('contract_templates')
                .select('template_file_url')
                .eq('role_target', emp.role || 'EMPLOYEE')
                .maybeSingle();
            templateData = byRole;
        }

        if (!templateData || !templateData.template_file_url) {
            throw new Error("Aucun modèle de contrat configuré pour ce rôle ou cet ID.");
        }

        // 3. Téléchargement et Remplissage du Word
        const fileResponse = await axios.get(templateData.template_file_url, { responseType: 'arraybuffer' });
        const zip = new PizZip(fileResponse.data);
        
        const doc = new Docxtemplater(zip, {
            paragraphLoop: true,
            linebreaks: true,
            nullGetter() { return " "; } 
        });
        
        let dateFinCalculee = "Indéterminée";
        const joursContrat = parseInt(emp.type_contrat); // On récupère 90, 180 ou 365
        
        if (joursContrat < 365 && emp.date_embauche) {
            const dateFin = new Date(emp.date_embauche);
            dateFin.setDate(dateFin.getDate() + joursContrat);
            dateFinCalculee = dateFin.toLocaleDateString('fr-FR');
        }

        const now = new Date();
        const dataToInject = {
            civilite: emp.civilite || 'Monsieur/Madame',
            nom_complet: emp.nom,
            poste: emp.poste || 'Collaborateur',
            matricule: emp.matricule || 'N/A',
            adresse: emp.adresse || 'Non renseignée',
            type_contrat: emp.type_contrat || 'Essai',
            departement: emp.departement || 'Général',
            employee_type: emp.employee_type || 'OFFICE',
            
            // Dates et Durées
            date_embauche: emp.date_embauche ? new Date(emp.date_embauche).toLocaleDateString('fr-FR') : '---',
            date_fin: dateFinCalculee, 
            duree_essai: emp.duree_essai || '3 mois',
            
            // Identité
            lieu_naissance: emp.lieu_naissance || '---',
            nationalite: emp.nationalite || 'Béninoise',
            temps_travail: emp.temps_travail || '40h',

            // Finances
            salaire_base: new Intl.NumberFormat('fr-FR').format(emp.salaire_brut_fixe || 0),
            transport: new Intl.NumberFormat('fr-FR').format(emp.indemnite_transport || 0),
            logement: new Intl.NumberFormat('fr-FR').format(emp.indemnite_logement || 0),
            
            // Signature
            lieu_signature: emp.lieu_signature || 'Cotonou',
            date_jour: now.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }),
            signature: SIGNATURE_PLACEHOLDER 
        };

        doc.render(dataToInject);
        const docxBuffer = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });

        // 4. CONVERSION EN PDF POUR LA VUE
        console.log("🔄 Conversion du brouillon en PDF...");
        const pdfBuffer = await convertAsync(docxBuffer, '.pdf', undefined);

        // 5. ENVOI DU PDF AU NAVIGATEUR
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename=Brouillon_Contrat.pdf');
        res.send(pdfBuffer);

    } catch (err) {
        console.error("Erreur Brouillon PDF:", err);
        res.status(500).json({ error: err.message });
    }
}



// ============================================================
        // 14. ARCHIVAGE CONTRAT (SIGNATURE ÉLECTRONIQUE OU SCAN) ✅
        // ============================================================
       else if (action === 'contract-upload') {

            // SÉCURITÉ STRICTE
            if (!checkPerm(req, 'can_see_employees')) {
                return res.status(403).json({ error: "Action non autorisée. Veuillez voir avec les RH." });
            }
            
            const { id, signature } = req.body; 
            let contractUrl = "";

            // 1. Récupération des données complètes de l'employé
            const { data: emp, error } = await supabase
                .from('employees')
                .select('*')
                .eq('id', id)
                .single();

            if (error || !emp) return res.status(404).json({ error: "Employé introuvable" });

            // --- CAS A : UPLOAD MANUEL (SCAN PHYSIQUE / PDF / PHOTO) ---
            if (req.files && req.files.length > 0) {
                console.log("📁 Réception d'un contrat scanné...");
                const file = req.files[0];
                const fileExt = file.originalname.split('.').pop();
                const fileName = `contrat_physique_${id}_${Date.now()}.${fileExt}`;
                
                const { error: storageErr } = await supabase.storage
                    .from('documents')
                    .upload(fileName, file.buffer, { contentType: file.mimetype });

                if (storageErr) throw storageErr;
                contractUrl = supabase.storage.from('documents').getPublicUrl(fileName).data.publicUrl;
            } 
            
            // --- CAS B : SIGNATURE ÉLECTRONIQUE (DOCX -> PDF) ---
            else if (signature) {
                console.log("✍️ Signature et Conversion PDF en cours...");

                try {
                    // --- RECHERCHE INTELLIGENTE DU MODÈLE (CORRECTIONS ICI) ---
                    let templateData = null;

                    // Tentative A : Par l'ID technique du modèle
                    if (emp.contract_template_id) {
                        const { data: byId } = await supabase.from('contract_templates')
                            .select('template_file_url')
                            .eq('id', emp.contract_template_id)
                            .maybeSingle();
                        templateData = byId;
                    }

                    // Tentative B : Par le Rôle (ou défaut EMPLOYEE)
                    if (!templateData) {
                        const { data: byRole } = await supabase.from('contract_templates')
                            .select('template_file_url')
                            .eq('role_target', emp.role || 'EMPLOYEE')
                            .maybeSingle();
                        templateData = byRole;
                    }

                    if (!templateData || !templateData.template_file_url) {
                        throw new Error("Modèle de contrat introuvable. Veuillez vérifier vos modèles DOCX.");
                    }
                    // --- FIN DE LA CORRECTION DE RECHERCHE ---

                    // 2. Récupération du modèle Word
                    const fileResponse = await axios.get(templateData.template_file_url, { responseType: 'arraybuffer' });
                    const zip = new PizZip(fileResponse.data);

                    // 3. Module Image pour la Signature
                    const imageModule = new ImageModule({
                        centered: false,
                        getImage: function(tagValue) {
                            const base64Data = tagValue.replace(/^data:image\/\w+;base64,/, "");
                            return Buffer.from(base64Data, 'base64');
                        },
                        getSize: function(img, tagValue) {
                            if (tagValue === SIGNATURE_PLACEHOLDER) {
                                return [300, 80]; 
                            }
                            return [180, 70]; 
                        }
                    });

                    // 4. Remplissage du document
                    const doc = new Docxtemplater(zip, {
                        paragraphLoop: true,
                        linebreaks: true,
                        modules: [imageModule],
                        nullGetter() { return " "; } 
                    });

                    const now = new Date();

                    let dateFinCalculee = "Indéterminée";
                    const joursContrat = parseInt(emp.type_contrat); 
                    
                    if (joursContrat < 365 && emp.date_embauche) {
                        const dateFin = new Date(emp.date_embauche);
                        dateFin.setDate(dateFin.getDate() + joursContrat);
                        dateFinCalculee = dateFin.toLocaleDateString('fr-FR');
                    }

                    const dataToInject = {
                        civilite: emp.civilite || 'Monsieur/Madame',
                        nom_complet: emp.nom,
                        poste: emp.poste || 'Collaborateur',
                        matricule: emp.matricule || 'N/A',
                        adresse: emp.adresse || 'Non renseignée',
                        type_contrat: emp.type_contrat || 'Essai',
                        departement: emp.departement || 'Général',
                        employee_type: emp.employee_type || 'OFFICE',
                        date_embauche: emp.date_embauche ? new Date(emp.date_embauche).toLocaleDateString('fr-FR') : '---',
                        date_fin: dateFinCalculee, 
                        duree_essai: emp.duree_essai || '3 mois',
                        lieu_naissance: emp.lieu_naissance || '---',
                        nationalite: emp.nationalite || 'Béninoise',
                        temps_travail: emp.temps_travail || '40h',
                        salaire_base: new Intl.NumberFormat('fr-FR').format(emp.salaire_brut_fixe || 0),
                        transport: new Intl.NumberFormat('fr-FR').format(emp.indemnite_transport || 0),
                        logement: new Intl.NumberFormat('fr-FR').format(emp.indemnite_logement || 0),
                        lieu_signature: emp.lieu_signature || 'Cotonou',
                        date_jour: now.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }),
                        signature: signature 
                    };

                    doc.render(dataToInject);

                    // 5. Conversion Word -> PDF
                    const docxBuffer = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
                    
                    console.log("🔄 Lancement de la conversion LibreOffice...");
                    const pdfBuffer = await convertAsync(docxBuffer, '.pdf', undefined);

                    // 6. Upload du PDF final
                    const pdfFileName = `contrat_signe_${id}_${Date.now()}.pdf`;
                    const { error: upErr } = await supabase.storage
                        .from('documents')
                        .upload(pdfFileName, pdfBuffer, { contentType: 'application/pdf' });

                    if (upErr) throw upErr;
                    contractUrl = supabase.storage.from('documents').getPublicUrl(pdfFileName).data.publicUrl;

                } catch (err) {
                    console.error("❌ Erreur Processus Contrat:", err);
                    return res.status(500).json({ error: "Échec de la génération du contrat PDF : " + err.message });
                }
            }

            // --- MISE À JOUR COMMUNE (Statut & URL) ---
            if (contractUrl) {
                await supabase.from('employees').update({ 
                    contract_status: 'Signé',
                    contrat_pdf_url: contractUrl 
                }).eq('id', id);

                return res.json({ status: "success", url: contractUrl });
            } else {
                return res.status(400).json({ error: "Aucune donnée de contrat ou signature reçue." });
            }
        }

       




            // ============================================================
// 6-B. LECTURE DES CONGÉS (CORRIGÉ POUR TOUS) ✅
// ============================================================
else if (action === 'read-leaves') {
    // MODIFICATION : On ajoute la jointure 'employees(solde_conges)' pour récupérer le compteur en temps réel
    let query = supabase
        .from('conges')
        .select('*, employees(solde_conges)') 
        .order('created_at', { ascending: false });

    // CAS 1 : Permission RH -> Voit tout
    if (req.user.permissions && req.user.permissions.can_see_employees) {
        // Pas de filtre
    }
    // CAS 2 : Employé -> Voit seulement ses demandes (Socle de base)
    else {
        query = query.eq('employee_id', req.user.emp_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    const mapped = data.map(l => ({
        id: l.id,
        record_id: l.id,
        Employees_nom: l.employees_nom || "Inconnu",
        Statut: l.statut, 
        Type: l.type || "Congé",
        "Date Début": l.date_debut,
        "Date Fin": l.date_fin,
        motif: l.motif,
        justificatif_link: l.justificatif_url,
        solde_actuel: l.employees ? (Array.isArray(l.employees) ? l.employees[0].solde_conges : l.employees.solde_conges) : 0
    }));
    return res.json(mapped);
}

        // ============================================================
        // 8. ACTIONS RECRUTEMENT (CORRIGÉ : MAPPING ACTION) ✅
        // ============================================================
        else if (action === 'candidate-action') {

            if (!checkPerm(req, 'can_see_recruitment')) {
                return res.status(403).json({ error: "Accès refusé aux actions de recrutement" });
            }
            
            // CORRECTION ICI : On accepte "action" ou "action_type" pour être compatible avec le HTML
            const id = req.body.id;
            const action_type = req.body.action || req.body.action_type; 
            const agent = req.body.agent;
            
            console.log(`⚡ Traitement : ${action_type} pour ID : ${id}`);

            // 1. S'assurer que l'ID est valide
            const candidateId = parseInt(id);
            if (isNaN(candidateId)) throw new Error("ID candidat invalide");

            // 2. Récupérer les infos du candidat
            const { data: candidat, error: candErr } = await supabase
                .from('candidatures')
                .select('*')
                .eq('id', id)
                .single();

            if (candErr || !candidat) {
                console.error("❌ Candidat introuvable:", candidateId);
                throw new Error("Candidat introuvable dans la base de données");
            }

            let nouveauStatut = "";
            let emailSujet = "";
            let emailHtml = "";


            // =========================================================
            // CAS 1 : INVITATION À UN ENTRETIEN
            // =========================================================
            if (action_type === 'VALIDER_POUR_ENTRETIEN') {
                nouveauStatut = "ENTRETIEN";
                emailSujet = `Votre candidature pour le poste de ${candidat.poste_vise}`;
                emailHtml = `
                    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
                        <p>Bonjour <strong>${candidat.nom_complet}</strong>,</p>
                        <p>Nous avons bien reçu votre candidature pour le poste de <strong>${candidat.poste_vise}</strong> et nous vous en remercions.</p>
                        <p>Votre profil a retenu toute notre attention. Nous serions ravis d'échanger avec vous de vive voix pour discuter de votre parcours et de vos motivations.</p>
                        <p>Nous vous proposons un entretien (en visio ou dans nos locaux) dans les prochains jours.</p>
                        <p>Merci de nous indiquer vos disponibilités pour la semaine à venir par retour de mail.</p>
                        <br>
                        <p>Cordialement,</p>
                        <p><strong>L'équipe Recrutement<br>CORP-HR</strong></p>
                    </div>`;
            } 

            // =========================================================
            // CAS 2 : REFUS IMMÉDIAT
            // =========================================================
            else if (action_type === 'REFUS_IMMEDIAT') {
                nouveauStatut = "Refusé";
                emailSujet = `Votre candidature au poste de ${candidat.poste_vise}`;
                emailHtml = `
                    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
                        <p>Bonjour <strong>${candidat.nom_complet}</strong>,</p>
                        <p>Nous vous remercions de l'intérêt que vous portez à notre entreprise et pour votre candidature au poste de <strong>${candidat.poste_vise}</strong>.</p>
                        <p>Cependant, après une lecture attentive de votre dossier, nous sommes au regret de vous informer que nous ne pouvons pas donner une suite favorable à votre candidature.</p>
                        <p>Nous conservons toutefois vos coordonnées afin de vous recontacter si une opportunité se présentait.</p>
                        <p>Nous vous souhaitons une excellente continuation.</p>
                        <br>
                        <p>Bien cordialement,</p>
                        <p><strong>L'équipe Recrutement</strong></p>
                    </div>`;
            }

            // =========================================================
            // CAS 3 : REFUS APRÈS ENTRETIEN
            // =========================================================
            else if (action_type === 'REFUS_APRES_ENTRETIEN') {
                nouveauStatut = "Refusé après entretien";
                emailSujet = `Suite à notre entretien - ${candidat.poste_vise}`;
                emailHtml = `
                    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
                        <p>Bonjour <strong>${candidat.nom_complet}</strong>,</p>
                        <p>Nous tenons à vous remercier pour le temps accordé lors de notre entretien.</p>
                        <p>Nous avons apprécié nos échanges. Toutefois, nous avons choisi un profil dont l'expérience est plus en adéquation avec nos besoins immédiats.</p>
                        <p>Ce choix ne remet pas en cause vos compétences. Nous vous souhaitons beaucoup de succès.</p>
                        <br>
                        <p>Sincèrement,</p>
                        <p><strong>L'équipe Recrutement<br>CORP-HR</strong></p>
                    </div>`;
            }

            // =========================================================
            // CAS 4 : EMBAUCHE (AVEC CRÉATION DE COMPTE)
            // =========================================================
else if (action_type === 'ACCEPTER_EMBAUCHE') {
    nouveauStatut = "Embauché";
    const generatedPassword = Math.random().toString(36).slice(-8) + "!23";
    const username = candidat.email;
    const siteLink = "https://dom4002.github.io/sirh-supabase-v2-frontend/";
    const empType = req.body.employee_type || 'OFFICE'; 
    const empDept = req.body.departement || 'À définir';
    const managerId = req.body.manager_id || null; // Récupération du manager si envoyé par le front

    const { data: existing } = await supabase.from('app_users').select('id').eq('email', username).single();
    
    if (!existing) {
        const { data: newUser } = await supabase.from('app_users').insert([{ email: username, password: generatedPassword, nom_complet: candidat.nom_complet }]).select().single();

        if (newUser) {
            const { data: nextMatricule, error: seqErr } = await supabase.rpc('get_next_formatted_matricule');
            if (seqErr) throw new Error("Erreur de génération de matricule");
            // -----------------------------------------------------

            // --- INITIALISATION DU COMPTE EMPLOYÉ ---
            // On récupère l'objet inséré (.select().single()) pour avoir son ID et calculer le path
            const { data: newEmp, error: empErr } = await supabase.from('employees').insert([{
                user_associated_id: newUser.id,
                matricule: nextMatricule,
                nom: candidat.nom_complet,
                employee_type: empType, 
                email: username,
                telephone: candidat.telephone,
                poste: candidat.poste_vise,
                departement: empDept, // Utilise maintenant le code (ex: 'IT')
                role: "EMPLOYEE",
                statut: "Actif",
                date_embauche: new Date().toISOString().split('T')[0],
                type_contrat: "Essai",
                solde_conges: 25,
                photo_url: candidat.photo_url || null,
                manager_id: managerId
            }]).select().single();

            if (!empErr && newEmp) {
                // --- NOUVEAU : CALCUL AUTOMATIQUE DU HIERARCHY_PATH ---
                let finalPath = String(newEmp.id);
                if (managerId) {
                    const { data: manager } = await supabase.from('employees')
                        .select('hierarchy_path')
                        .eq('id', managerId)
                        .single();
                    
                    if (manager && manager.hierarchy_path) {
                        finalPath = `${manager.hierarchy_path}/${newEmp.id}`;
                    }
                }
                // Mise à jour du chemin
                await supabase.from('employees').update({ hierarchy_path: finalPath }).eq('id', newEmp.id);
            }
        }
    }

    emailSujet = `Félicitations ! Confirmation d'embauche - ${candidat.poste_vise}`;
    emailHtml = `
        <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
            <h2 style="color: #10b981;">Félicitations ${candidat.nom_complet} !</h2>
            <p>Nous confirmons votre embauche au poste de <strong>${candidat.poste_vise}</strong>.</p>
            <p>Voici vos identifiants pour accéder à votre espace SIRH :</p>
            <div style="background: #f3f4f6; padding: 15px; border-radius: 8px;">
                <p>🔗 <strong>Lien :</strong> <a href="${siteLink}">${siteLink}</a></p>
                <p>👤 <strong>Identifiant :</strong> ${username}</p>
                <p>🔑 <strong>Mot de passe :</strong> ${generatedPassword}</p>
            </div>
            <br>
            <p>Bienvenue dans l'équipe !</p>
        </div>`;
}

            // 3. Mise à jour statut Supabase
            await supabase.from('candidatures').update({ statut: nouveauStatut }).eq('id', candidateId);

            // 4. Envoi Email
            if (emailHtml !== "" && candidat.email) {
                try {
                    
                    await sendEmailAPI(candidat.email, emailSujet, emailHtml);

                    console.log(`✅ Email envoyé à ${candidat.email}`);
                } catch (mErr) { console.error("❌ Erreur SMTP:", mErr.message); }
            }

            // 5. Log
            await supabase.from('logs').insert([{ agent: agent || 'RH', action: 'RECRUTEMENT', details: `${candidat.nom_complet} -> ${nouveauStatut}` }]);

            return res.json({ status: "success", message: `Candidat passé en ${nouveauStatut}` });
        }



  // ============================================================
        // 10. GÉNÉRATEUR DE RAPPORTS (AMPLITUDE + FIX LOGIQUE ADMIN) ✅
        // ============================================================
// ============================================================
        // 10. GÉNÉRATEUR DE RAPPORTS (AMPLITUDE + SÉCURITÉ ADMIN) ✅
        // ============================================================
        else if (action === 'read-report') {
            // 1. DÉTECTION DU MODE ET DU CONTEXTE
            const isGlobalMode = req.query.mode === 'GLOBAL';
            const isPersonalMode = req.query.mode === 'PERSONAL';
            
            // SÉCURITÉ : Pour voir le global, il faut le droit Dashboard
            if (isGlobalMode && !checkPerm(req, 'can_see_dashboard')) {
                return res.status(403).json({ error: "Accès refusé aux rapports globaux" });
            }
            
            const { period } = req.query;
            const now = new Date();
            const todayStr = now.toISOString().split('T')[0];

            try {
                // 2. PRÉPARATION DE LA REQUÊTE AVEC LES INFOS EMPLOYÉS
                let query = supabase
                    .from('pointages')
                    .select('*, employees!inner(nom, hierarchy_path, departement)');

                // 3. LOGIQUE DE FILTRAGE (QUI VOIT QUOI)
                if (isPersonalMode) {
                    // L'utilisateur ne voit que ses propres données
                    query = query.eq('employee_id', req.user.emp_id);
                } 
                else if (isGlobalMode) {
                    // --- PROTECTION ET POUVOIR ADMIN ---
                    // Si l'utilisateur a le droit de voir tous les employés (ADMIN / RH)
                    if (checkPerm(req, 'can_see_employees')) {
                        console.log(`👑 ADMIN [${req.user.nom}] accède au rapport global.`);
                        // AUCUN FILTRE SUPPLÉMENTAIRE : L'Admin voit tout.
                    } 
                    // Si c'est un simple MANAGER, on filtre par sa lignée
                    else {
                        const { data: requester } = await supabase.from('employees')
                            .select('hierarchy_path, management_scope')
                            .eq('id', req.user.emp_id)
                            .single();

                        if (requester) {
                            let securityConditions = [];
                            securityConditions.push(`employees.hierarchy_path.eq.${requester.hierarchy_path}`);
                            securityConditions.push(`employees.hierarchy_path.ilike.${requester.hierarchy_path}/%`);

                            if (requester.management_scope?.length > 0) {
                                const scopeList = `(${requester.management_scope.map(s => `"${s}"`).join(',')})`;
                                securityConditions.push(`employees.departement.in.${scopeList}`);
                            }
                            query = query.or(securityConditions.join(','));
                        }
                    }
                }

                // 4. FILTRAGE PAR PÉRIODE
                if (period === 'today') {
                    query = query.gte('heure', `${todayStr}T00:00:00`).lte('heure', `${todayStr}T23:59:59`);
                } else {
                    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
                    query = query.gte('heure', startOfMonth);
                }

                const { data: pointages, error } = await query.order('heure', { ascending: true });
                if (error) throw error;

                // --- RENDU : AUJOURD'HUI (LISTE DES PRÉSENTS) ---
                if (period === 'today') {
                    const firstInMap = {};
                    (pointages || []).forEach(p => {
                        if (p.action === 'CLOCK_IN' && !firstInMap[p.employee_id]) {
                            firstInMap[p.employee_id] = p;
                        }
                    });

                    const report = Object.values(firstInMap).map(p => ({
                        nom: p.employees ? p.employees.nom : "Inconnu",
                        heure: new Date(p.heure).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'}),
                        zone: p.zone_detectee || "Bureau",
                        Statut: "PRÉSENT"
                    }));
                    return res.json(report);
                } 
                
                // --- RENDU : MENSUEL (CALCUL D'AMPLITUDE) ---
                else {
                    const dailyStats = {};
                    (pointages || []).forEach(p => {
                        const empId = p.employee_id;
                        const localDate = new Date(p.heure).toLocaleDateString('fr-CA'); 
                        const groupKey = `${empId}_${localDate}`;

                        if (!dailyStats[groupKey]) {
                            dailyStats[groupKey] = { empId, nom: p.employees?.nom || "Inconnu", firstIn: null, lastOut: null };
                        }

                        const time = new Date(p.heure).getTime();
                        if (p.action === 'CLOCK_IN') {
                            if (!dailyStats[groupKey].firstIn || time < dailyStats[groupKey].firstIn) dailyStats[groupKey].firstIn = time;
                        } else if (p.action === 'CLOCK_OUT') {
                            if (!dailyStats[groupKey].lastOut || time > dailyStats[groupKey].lastOut) dailyStats[groupKey].lastOut = time;
                        }
                    });

                    const monthlySummary = {};
                    Object.values(dailyStats).forEach(day => {
                        if (!monthlySummary[day.empId]) {
                            monthlySummary[day.empId] = { nom: day.nom, totalMs: 0, joursPresence: 0 };
                        }
                        if (day.firstIn) monthlySummary[day.empId].joursPresence += 1;
                        if (day.firstIn && day.lastOut) {
                            const amplitudeMs = day.lastOut - day.firstIn;
                            if (amplitudeMs > 0) monthlySummary[day.empId].totalMs += amplitudeMs;
                        }
                    });

                    const finalReport = Object.values(monthlySummary).map(s => {
                        const totalMinutes = Math.floor(s.totalMs / (1000 * 60));
                        const hours = Math.floor(totalMinutes / 60);
                        const mins = totalMinutes % 60;
                        return {
                            mois: now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }),
                            nom: s.nom,
                            jours: s.joursPresence,
                            heures: `${hours}h ${mins.toString().padStart(2, '0')}m`,
                            Statut: "Clôturé"
                        };
                    });

                    return res.json(finalReport);
                }
            } catch (err) {
                console.error("Erreur Rapport:", err.message);
                return res.status(500).json({ error: err.message });
            }
        }


            
   else if (action === 'ingest-candidate') {
            const b = req.body;
            console.log(`📥 Candidature reçue. Nom : ${b.nom_complet}`);

            // A. GESTION DES FICHIERS (On les traite en premier)
            let uploadedDocs = { cv_url: null, lm_url: null, diploma_url: null, id_card_url: null };

            if (req.files && req.files.length > 0) {
                for (const file of req.files) {
                    const fileName = `${Date.now()}_${file.originalname.replace(/\s/g, '_')}`;
                    await supabase.storage.from('documents').upload(fileName, file.buffer, { contentType: file.mimetype });
                    const { data } = supabase.storage.from('documents').getPublicUrl(fileName);
                    
                    if (file.fieldname === 'cv') uploadedDocs.cv_url = data.publicUrl;
                    if (file.fieldname === 'lm') uploadedDocs.lm_url = data.publicUrl;
                    if (file.fieldname === 'diploma') uploadedDocs.diploma_url = data.publicUrl;
                    if (file.fieldname === 'id_card') uploadedDocs.id_card_url = data.publicUrl;
                }
            }
            
            // B. INSERTION DANS SUPABASE (En s'assurant que les données existent)
            const { error } = await supabase
                .from('candidatures')
                .insert([{
                    nom_complet: b.nom_complet,
                    email: b.email,
                    telephone: b.telephone,
                    poste_vise: b.poste_vise,
                    date_naissance: b.date_naissance || null,
                    cv_url: uploadedDocs.cv_url,
                    lm_url: uploadedDocs.lm_url,
                    diploma_url: uploadedDocs.diploma_url,
                    id_card_url: uploadedDocs.id_card_url,
                    statut: 'Nouveau'
                }]);

            if (error) {
                console.error("❌ Erreur Insertion Candidature:", error.message);
                return res.status(500).json({ error: error.message });
            }

            console.log("✅ Candidature de " + b.nom_complet + " enregistrée.");
            return res.json({ status: "success" });
        }

// ============================================================
        // MISE À JOUR PROFIL (EMPLOYÉ OU RH)
        // ============================================================
        else if (action === 'emp-update') {
            
            const { id, email, phone, address, dob, doc_type } = req.body;
            
            // 1. IDENTIFICATION SÉCURISÉE (Via Token JWT)
            const requesterId = String(req.user.emp_id);
            const targetId = String(id);
            const isOwner = requesterId === targetId;
            const isRH = req.user.permissions && req.user.permissions.can_see_employees;

            // 2. PREMIER FILTRE : QUI A LE DROIT D'ENTRER ?
            // Ni le propriétaire, ni un RH => Dehors.
            if (!isOwner && !isRH) {
                return res.status(403).json({ error: "Interdit : Vous ne pouvez modifier que votre profil." });
            }
            
            console.log(`📝 Update ID ${targetId} (Type: ${doc_type}) par ${req.user.nom}`);

            // 3. DEUXIÈME FILTRE : RESTRICTION DES DOCUMENTS
            // Liste des types que l'employé peut modifier seul
            const allowedForEmployee = ['text_update', 'id_card', 'photo'];

            // Si c'est l'employé (et qu'il n'est pas RH), on vérifie s'il touche à un doc interdit
            if (!isRH && !allowedForEmployee.includes(doc_type)) {
                console.error("🚫 Bloqué : L'employé tente de modifier un document RH");
                return res.status(403).json({ error: "Modification interdite. Ce document est géré par les RH." });
            }

            // --- LOGIQUE DE MISE À JOUR ---
            let updates = {};

            // Champs texte (Uniquement si envoyés)
            if (email) updates.email = email;
            if (phone) updates.telephone = phone;
            if (address) updates.adresse = address;
            if (dob) updates.date_naissance = dob;

            // Gestion de l'upload de fichier (Photo ou Document)
            if (req.files && req.files.length > 0) {
                const file = req.files[0];
                if (file) {
                    const fileName = `${doc_type}_${targetId}_${Date.now()}`;
                    
                    // Upload vers Supabase Storage
                    const { error: storageErr } = await supabase.storage
                        .from('documents')
                        .upload(fileName, file.buffer, { contentType: file.mimetype });

                    if (storageErr) throw storageErr;

                    const { data } = supabase.storage.from('documents').getPublicUrl(fileName);
                    
                    // Mapping des colonnes en base de données
                    if (doc_type === 'text_update' || doc_type === 'photo') updates.photo_url = data.publicUrl;
                    else if (doc_type === 'id_card') updates.id_card_url = data.publicUrl;
                    else if (doc_type === 'cv') updates.cv_url = data.publicUrl;
                    else if (doc_type === 'contrat') updates.contrat_pdf_url = data.publicUrl;
                    else if (doc_type === 'diploma') updates.diploma_url = data.publicUrl;
                    else if (doc_type === 'attestation') updates.attestation_url = data.publicUrl;
                }
            }

            // Si rien à mettre à jour
            if (Object.keys(updates).length === 0) {
                return res.json({ status: "success", message: "Aucune modification détectée" });
            }

            // Exécution de la mise à jour
            const { error } = await supabase
                .from('employees')
                .update(updates)
                .eq('id', targetId);

            if (error) {
                console.error("❌ Erreur Supabase Update:", error.message);
                throw error;
            }

            return res.json({ status: "success" });
        }





      // ============================================================
        // 11. MISE À JOUR ADMINISTRATIVE (LOGIQUE PARTIELLE) ✅
        // ============================================================
        else if (action === 'update') {
            if (!checkPerm(req, 'can_see_employees')) { 
                return res.status(403).json({ error: "Accès refusé à l'administration des profils" });
            }

            const q = req.query; // Alias pour plus de clarté
            const id = q.id;
            const agent = q.agent;

            console.log(`🛠️ Mise à jour partielle pour ID ${id} par ${agent}`);

            // 1. On construit l'objet de mise à jour dynamiquement
            let updates = {};

            // Informations de base (seulement si présentes dans la requête)
            if (q.statut) updates.statut = q.statut;
            if (q.role) updates.role = q.role;
            if (q.dept) updates.departement = q.dept;
            if (q.employee_type) updates.employee_type = q.employee_type;
            if (q.poste) updates.poste = q.poste;

            // Gestion de la hiérarchie
            if (q.manager_id !== undefined) {
                updates.manager_id = (q.manager_id === "null" || q.manager_id === "") ? null : q.manager_id;
            }
            if (q.scope) {
                try {
                    updates.management_scope = JSON.parse(q.scope);
                } catch (e) { console.error("Erreur parse scope"); }
            }

            // 2. LOGIQUE CONTRAT : Uniquement si demandé par le front-end
            if (q.recalculate_contract === 'true') {
                updates.date_embauche = q.start_date;
                updates.type_contrat = q.limit === '365' ? 'CDI' : (q.limit === '180' ? 'CDD' : 'Essai');
                
                // On utilise la fonction de calcul de date de fin
                if (typeof getEndDate === 'function') {
                    updates.date_fin_contrat = getEndDate(q.start_date, q.limit);
                }
            }

            // 3. FINANCES (On vérifie si la valeur est fournie)
            if (q.salaire_brut_fixe !== undefined) updates.salaire_brut_fixe = parseFloat(q.salaire_brut_fixe) || 0;
            if (q.indemnite_transport !== undefined) updates.indemnite_transport = parseFloat(q.indemnite_transport) || 0;
            if (q.indemnite_logement !== undefined) updates.indemnite_logement = parseFloat(q.indemnite_logement) || 0;

            // 4. RÉINITIALISATION FORCÉE
            if (q.force_init === 'true') {
                updates.solde_conges = 25;
                updates.contract_status = 'Non signé';
            }

            // 5. Exécution de la mise à jour (Supabase n'écrase que les clés présentes dans 'updates')
            const { error } = await supabase
                .from('employees')
                .update(updates)
                .eq('id', id);

            if (error) {
                console.error("❌ Erreur Supabase Update:", error.message);
                throw error;
            }

            // Log d'audit
            await supabase.from('logs').insert([{ 
                agent: agent, 
                action: 'MODIF_ADMIN_PROFIL', 
                details: `Champs modifiés pour l'ID ${id} : ${Object.keys(updates).join(', ')}` 
            }]);

            return res.json({ status: "success", message: "Mise à jour effectuée." });
        }










            // --- LISTER LES RÔLES RÉELS DE LA BDD ---
else if (action === 'list-roles') {
    try {
        const { data, error } = await supabase
            .from('role_permissions')
            .select('role_name')
            .order('role_name', { ascending: true });

        if (error) throw error;
        return res.json(data);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}



    

        // ============================================================
        // 6-C. ACTION SUR UN CONGÉ (VALIDATION AVEC CALCUL JOURS OUVRÉS) ✅
        // ============================================================
                else if (action === 'leave-action') {
        
                    if (!req.user.permissions || !req.user.permissions.can_see_employees) { // Pour valider les congés des autres
                        return res.status(403).json({ error: "Accès refusé à la gestion des congés" });
                    }
                    
                    const { id, decision, agent } = req.body; 
                    console.log(`⚖️ Décision RH : ${decision} pour le congé ID ${id}`);
        
                    // 1. Récupérer les détails du congé et de l'employé lié
                    const { data: conge, error: congeErr } = await supabase
                        .from('conges')
                        .select('*, employees(*)')
                        .eq('id', id)
                        .single();
        
                    if (congeErr || !conge) throw new Error("Congé introuvable");
        
                    if (conge.statut === decision) {
                        return res.json({ status: "success", message: "Déjà traité" });
                    }
        
                    const employe = Array.isArray(conge.employees) ? conge.employees[0] : conge.employees;
                    if (!employe) throw new Error("Employé lié introuvable");
        
                    const typeConge = conge.type; 
                    
                    // --- 2. CALCUL INTELLIGENT DES JOURS OUVRÉS (Lundi-Vendredi) ---
                    const debut = new Date(conge.date_debut);
                    const fin = new Date(conge.date_fin);
                    let nbJours = 0;
                    let loopDate = new Date(debut);
        
                    // On boucle jour par jour
                    while (loopDate <= fin) {
                        const dayOfWeek = loopDate.getDay();
                        // Si ce n'est pas Dimanche (0) et pas Samedi (6), on compte
                        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                            nbJours++;
                        }
                        // Jour suivant
                        loopDate.setDate(loopDate.getDate() + 1);
                    }
                    // -------------------------------------------------------------
        
                    // 3. Mise à jour du statut du congé dans Supabase
                    const { error: updateErr } = await supabase
                        .from('conges')
                        .update({ statut: decision })
                        .eq('id', id);
        
                    if (updateErr) throw updateErr;
        
                    // 4. LOGIQUE DE MISE À JOUR DE L'EMPLOYÉ (Solde + Statut Global)
                    if (decision === 'Validé') {
                        let updates = { statut: 'Congé' }; 
        
                        // On déduit le solde uniquement pour Congé Payé et Maladie
                        // (On utilise le nouveau nbJours calculé sans les weekends)
                        if (typeConge === 'Congé Payé' || typeConge === 'Maladie') {
                            const soldeActuel = parseFloat(employe.solde_conges) || 0;
                            updates.solde_conges = soldeActuel - nbJours;
                        }
        
                        await supabase
                            .from('employees')
                            .update(updates)
                            .eq('id', employe.id);
                        
                        console.log(`📉 Employé ${employe.nom} mis à jour : Statut=Congé, Déduit=${nbJours}j`);
                    } 
                    else if (decision === 'Refusé') {
                        await supabase
                            .from('employees')
                            .update({ statut: 'Actif' })
                            .eq('id', employe.id);
                    }
        
                    // Emails
                    let emailSubject = "";
                    let emailHtml = "";
        
                    if (decision === 'Validé') {
                        emailSubject = `Approbation de votre demande de congé - ${employe.nom}`;
                        emailHtml = `
                            <div style="font-family: Arial, sans-serif; line-height: 1.6;">
                                <p>Bonjour ${employe.nom},</p>
                                <p>Nous avons le plaisir de vous informer que votre demande de <strong>${typeConge}</strong> a été officiellement <strong>APPROUVÉE</strong>.</p>
                                <p><strong>Durée validée :</strong> ${nbJours} jours ouvrés (Week-ends exclus).</p>
                                <p>Votre statut a été mis à jour dans le système. Nous vous souhaitons une excellente période de repos.</p>
                                <br>
                                <p>Cordialement,<br>Le Service RH</p>
                            </div>`;
                    } else {
                        emailSubject = `Mise à jour concernant votre demande de congé`;
                        emailHtml = `
                            <div style="font-family: Arial, sans-serif; line-height: 1.6;">
                                <p>Bonjour ${employe.nom},</p>
                                <p>Nous vous informons que votre demande de <strong>${typeConge}</strong> n'a pas pu être validée par ${agent || 'le service RH'}.</p>
                                <p>Conformément à nos procédures internes, nous vous invitons à vous rapprocher de votre responsable pour obtenir plus de précisions.</p>
                                <br>
                                <p>Cordialement,<br>Le service des Ressources Humaines</p>
                            </div>`;
                    }
        
                    try {
                        if (employe.email) {
                          await sendEmailAPI(employe.email, emailSubject, emailHtml);
                        }
                    } catch (mErr) {
                        console.error("❌ Erreur envoi mail décision:", mErr.message);
                    }
        
                    // 6. Log d'audit
                    await supabase.from('logs').insert([{
                        agent: agent || 'Système',
                        action: 'DÉCISION_CONGÉ',
                        details: `${decision} pour ${employe.nom} (${nbJours}j ouvrés)`
                    }]);
        
                    return res.json({ status: "success", message: `Demande ${decision.toLowerCase()} (${nbJours}j déduits)` });
                }




       else if (action === 'get-boss-summary') {
            const { month, year } = req.query;
            const startDate = `${year}-${month}-01`;

            // On récupère les visites de tous les délégués pour le mois
            const { data, error } = await supabase
                .from('visit_reports')
                .select('*, employees(nom, matricule, poste), mobile_locations(name, zone_name)')
                .gte('check_in_time', startDate);

            if (error) throw error;

            // On organise par employé
            const summary = {};
            data.forEach(v => {
                const e = v.employees;
                if (!summary[e.nom]) summary[e.nom] = { nom: e.nom, matricule: e.matricule, total: 0, details: [] };
                
                summary[e.nom].total++;
                summary[e.nom].details.push({
                    lieu: v.mobile_locations.name,
                    zone: v.mobile_locations.zone_name,
                    date: v.check_in_time,
                    resultat: v.outcome,
                    notes: v.notes
                });
            });

            return res.json(Object.values(summary));
        }



           
// ============================================================
        // 15. POINTAGE (VERSION UNIVERSELLE : SYNCHRO TOTALE) ✅
        // ============================================================
        else if (action === 'clock') {
            if (!checkPerm(req, 'can_clock')) return res.status(403).json({ error: "Interdit" });
            
            const { 
                id, action: clockAction, gps, ip, outcome, report, 
                is_last_exit, presentedProducts, time, 
                schedule_id, forced_location_id, 
                prescripteur_id, contact_nom_libre 
            } = req.body;
            
            const eventTime = time ? new Date(time) : new Date();
            const today = eventTime.toISOString().split('T')[0];
            const [userLat, userLon] = gps.split(',').map(parseFloat);
            
            let proofUrl = null;

            // Gestion photo (Inchangée)
            if (req.files && req.files.length > 0) {
                const file = req.files.find(f => f.fieldname === 'proof_photo');
                if (file) {
                    const fileName = `visite_proof_${id}_${Date.now()}.jpg`;
                    const { error: upErr } = await supabase.storage.from('documents').upload(fileName, file.buffer, { contentType: file.mimetype });
                    if (!upErr) proofUrl = supabase.storage.from('documents').getPublicUrl(fileName).data.publicUrl;
                }
            }

            try {
                const { data: emp } = await supabase.from('employees').select('employee_type').eq('id', id).single();
                const isMobileAgent = (emp && emp.employee_type === 'MOBILE');

                // --- SÉCURITÉ FIXES ---
                if (!isMobileAgent) {
                    const { data: existing } = await supabase.from('pointages').select('action').eq('employee_id', id).gte('heure', `${today}T00:00:00`);
                    if (clockAction === 'CLOCK_IN' && existing.some(p => p.action === 'CLOCK_IN')) return res.status(403).json({ error: "Entrée déjà validée." });
                    if (clockAction === 'CLOCK_OUT' && existing.some(p => p.action === 'CLOCK_OUT')) return res.status(403).json({ error: "Sortie déjà validée." });
                }

                // --- LOGIQUE GPS (Inchangée) ---
                let detectedLoc = null;
                if (forced_location_id && clockAction === 'CLOCK_IN') {
                    const { data: loc } = await supabase.from('mobile_locations').select('*').eq('id', forced_location_id).single();
                    if (loc) {
                        const dist = getDistanceInMeters(userLat, userLon, loc.latitude, loc.longitude);
                        if (dist <= loc.radius) {
                            detectedLoc = { name: loc.name, id: loc.id, table: 'mobile_locations' };
                        } else {
                            return res.status(403).json({ error: `Échec GPS. Vous êtes à ${Math.round(dist)}m de ${loc.name}. Approchez-vous.` });
                        }
                    }
                }

                if (!detectedLoc) {
                    const [zonesRes, mobilesRes] = await Promise.all([
                        supabase.from('zones').select('*').eq('actif', true),
                        supabase.from('mobile_locations').select('*').eq('is_active', true)
                    ]);
                    let allPlaces = [];
                    if (zonesRes.data) zonesRes.data.forEach(z => allPlaces.push({ id: z.id, name: z.nom, lat: z.latitude, lon: z.longitude, radius: z.rayon, table: 'zones' }));
                    if (mobilesRes.data) mobilesRes.data.forEach(m => allPlaces.push({ id: m.id, name: m.name, lat: m.latitude, lon: m.longitude, radius: m.radius, table: 'mobile_locations' }));
                    for (let loc of allPlaces) {
                        const d = getDistanceInMeters(userLat, userLon, loc.lat, loc.lon);
                        if (d <= loc.radius) { detectedLoc = loc; break; }
                    }
                }

                if (!detectedLoc) return res.status(403).json({ error: "Lieu inconnu. Vous n'êtes sur aucun site répertorié." });

                // --- 2. CALCUL DE LA CLÔTURE UNIVERSELLE ---
                // Si c'est une sortie : c'est final si (Mobile + case cochée) OU (Agent de bureau)
                const isFinalOut = (clockAction === 'CLOCK_OUT' && (is_last_exit === 'true' || is_last_exit === true || !isMobileAgent));

                // ENREGISTREMENT POINTAGE
                await supabase.from('pointages').insert([{
                    employee_id: id,
                    action: clockAction,
                    heure: eventTime,
                    gps_lat: userLat, gps_lon: userLon,
                    zone_detectee: detectedLoc.name,
                    ip_address: ip,
                    statut: 'Validé',
                    is_final_out: isFinalOut
                }]);

                // --- 3. MISE À JOUR SYNCHRONISÉE DES STATUTS ---
                if (clockAction === 'CLOCK_IN') {
                    if (isMobileAgent) {
                        if (schedule_id) await supabase.from('employee_schedules').update({ status: 'CHECKED_IN' }).eq('id', schedule_id);
                        await supabase.from('visit_reports').insert([{
                            employee_id: id, check_in_time: eventTime, location_name: detectedLoc.name,
                            location_id: (detectedLoc.table === 'mobile_locations') ? detectedLoc.id : null,
                            schedule_ref_id: schedule_id || null
                        }]);
                    }
                    // Tout le monde passe en "En Poste" quand il entre
                    await supabase.from('employees').update({ statut: 'En Poste' }).eq('id', id);
                } 
        else {
                    // CAS SORTIE (CLOCK_OUT)
                    if (isMobileAgent) {
                        // 1. On cherche une visite ouverte (cas normal)
                        const { data: lastVisit } = await supabase.from('visit_reports')
                            .select('id, check_in_time').eq('employee_id', id).is('check_out_time', null)
                            .order('check_in_time', { ascending: false }).limit(1).maybeSingle();

                        const reportPayload = {
                            check_out_time: eventTime, 
                            outcome: outcome || 'VU', 
                            notes: report || '', 
                            proof_url: proofUrl,
                            duration_minutes: 0, // Sera recalculé si on a une entrée
                            presented_products: typeof presentedProducts === 'string' ? JSON.parse(presentedProducts) : (presentedProducts || []),
                            prescripteur_id: (prescripteur_id && prescripteur_id !== 'autre') ? prescripteur_id : null,
                            contact_nom_libre: contact_nom_libre || null
                        };

                        if (lastVisit) {
                            // CAS A : On a trouvé l'entrée correspondante (Parfait)
                            const duration = Math.round((eventTime - new Date(lastVisit.check_in_time)) / (1000 * 60));
                            reportPayload.duration_minutes = duration > 0 ? duration : 1;
                            
                            await supabase.from('visit_reports').update(reportPayload).eq('id', lastVisit.id);
                        } else {
                            // CAS B (CORRECTION) : Pas d'entrée trouvée (Bug précédent ou oubli)
                            // On CRÉE une visite "orpheline" pour ne pas perdre le rapport
                            console.log("⚠️ Sortie sans entrée détectée : Création d'un rapport de visite orphelin.");
                            
                            reportPayload.employee_id = id;
                            reportPayload.check_in_time = eventTime; // On met la même heure que la sortie
                            reportPayload.location_name = detectedLoc.name;
                            reportPayload.location_id = (detectedLoc.table === 'mobile_locations') ? detectedLoc.id : null;
                            reportPayload.duration_minutes = 1; // 1 min par défaut
                            
                            await supabase.from('visit_reports').insert([reportPayload]);
                        }

                        if (isFinalOut && schedule_id) {
                            await supabase.from('employee_schedules').update({ status: 'COMPLETED' }).eq('id', schedule_id);
                        }
                    }
                    
                    // RÈGLE D'OR : À la sortie, on repasse le texte en "Actif"
                    await supabase.from('employees').update({ statut: 'Actif' }).eq('id', id);
                }

                return res.json({ status: "success", zone: detectedLoc.name });

            } catch (err) {
                console.error("Crash global route clock:", err);
                return res.status(500).json({ error: err.message });
            }
        }


           // ============================================================
// SOUMISSION DU BILAN JOURNALIER (AVEC CALCUL AUTO DU TEMPS)
// ============================================================
else if (action === 'submit-daily-report') {
    const { employee_id, summary, needs_restock } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const startDay = `${today}T00:00:00`;
    const endDay = `${today}T23:59:59`;
    
    let photoUrl = null;

    // A. GESTION DE LA PHOTO DU RAPPORT (Multer)
    if (req.files && req.files.length > 0) {
        const file = req.files.find(f => f.fieldname === 'report_doc');
        if (file) {
            const fileName = `rapport_${employee_id}_${today}_${Date.now()}.${file.originalname.split('.').pop()}`;
            const { error: upErr } = await supabase.storage.from('documents').upload(fileName, file.buffer, { contentType: file.mimetype });
            if (!upErr) {
                const { data } = supabase.storage.from('documents').getPublicUrl(fileName);
                photoUrl = data.publicUrl;
            }
        }
    }

    try {
        // B. CALCUL AUTOMATIQUE : TEMPS TOTAL ET STATS PRODUITS
        // On récupère toutes les visites que l'agent a faites AUJOURD'HUI
        const { data: visits } = await supabase
            .from('visit_reports')
            .select('duration_minutes, presented_products')
            .eq('employee_id', employee_id)
            .gte('check_in_time', startDay)
            .lte('check_in_time', endDay);

        let totalMinutes = 0;
        const stats = {};
        
        if (visits && visits.length > 0) {
            visits.forEach(v => {
                // 1. On additionne les minutes de chaque visite
                totalMinutes += (v.duration_minutes || 0);

                // 2. On compte les produits présentés (Logique de comptage)
                let products = v.presented_products;
                if (typeof products === 'string') { try { products = JSON.parse(products); } catch(e) { products = []; } }
                if (Array.isArray(products)) {
                    products.forEach(p => {
                        let pName = typeof p === 'string' ? p : (p.name || p.NAME || p.Name);
                        if (pName) stats[pName] = (stats[pName] || 0) + 1;
                    });
                }
            });
        }

        // C. ENREGISTREMENT EN BASE DE DONNÉES (Table daily_reports)
        // On vérifie si un bilan existe déjà pour aujourd'hui
        const { data: existing } = await supabase
            .from('daily_reports')
            .select('id')
            .eq('employee_id', employee_id)
            .eq('report_date', today)
            .maybeSingle();

        const payload = { 
            summary: summary, 
            needs_restock: (needs_restock === 'true'), 
            products_stats: stats, 
            total_work_minutes: totalMinutes, // ✅ SAUVEGARDE DU TEMPS CUMULÉ
            updated_at: new Date() 
        };
        if (photoUrl) payload.photo_url = photoUrl;

        if (existing) {
            // Mise à jour si déjà envoyé
            await supabase.from('daily_reports').update(payload).eq('id', existing.id);
        } else {
            // Création si c'est le premier de la journée
            payload.employee_id = employee_id;
            payload.report_date = today;
            await supabase.from('daily_reports').insert([payload]);
        }

        return res.json({ status: "success", total_time: totalMinutes });

    } catch (dbErr) {
        console.error("Erreur serveur bilan journalier:", dbErr);
        return res.status(500).json({ error: dbErr.message });
    }
}

        // ============================================================
        // LECTURE DES RAPPORTS JOURNALIERS (POUR MANAGERS/RH) ✅
        // ============================================================
       else if (action === 'read-daily-reports') {
            try {
                // 1. Paramètres de pagination (Standardisation pour le long terme)
                const page = parseInt(req.query.page) || 1;
                const limit = parseInt(req.query.limit) || 20;
                const offset = (page - 1) * limit;

                // 2. Initialisation de la requête avec jointure explicite
                let query = supabase
                    .from('daily_reports')
                    .select('*, employees:employee_id (nom, matricule, poste)', { count: 'exact' });

                // --- SÉCURITÉ : FILTRAGE HIÉRARCHIQUE ---
                // Vérifie si l'utilisateur a le droit de voir tous les rapports
                const canSeeAll = req.user.permissions && (req.user.permissions.can_view_reports || req.user.role === 'ADMIN' || req.user.role === 'RH');
                
                if (!canSeeAll) {
                    // Si c'est un employé simple, on le force à ne voir QUE ses propres bilans
                    console.log(`🔐 Profil Personnel : Filtrage des bilans pour ${req.user.emp_id}`);
                    query = query.eq('employee_id', req.user.emp_id);
                }
                // ----------------------------------------

                // 3. Exécution avec tri, pagination et plage (range)
                const { data, error, count } = await query
                    .order('report_date', { ascending: false })
                    .range(offset, offset + limit - 1);

                if (error) throw error;

                // 4. Renvoi des données avec les métadonnées de pagination
                return res.json({
                    data: data,
                    meta: {
                        total: count,
                        page: page,
                        last_page: Math.ceil(count / limit)
                    }
                });
                
            } catch (err) {
                console.error("Erreur read-daily-reports:", err.message);
                return res.status(500).json({ error: err.message });
            }
        }



            else if (action === 'read-config-salaries') {
                const { data, error } = await supabase
                    .from('salaries_config')
                    .select('*')
                    .eq('is_active', true);
            
                if (error) throw error;
                return res.json(data);
            }


            else if (action === 'get-performance-report') {
            const { start_date, end_date } = req.query;

            // On récupère la synthèse des visites groupées par employé et par lieu
            const { data, error } = await supabase
                .from('visit_reports')
                .select('*, employees(nom, matricule), mobile_locations(name, zone_name)')
                .gte('check_in_time', start_date)
                .lte('check_in_time', end_date);

            if (error) throw error;

            // On transforme les données pour le tableau de bord du Boss
            const stats = {};
            data.forEach(v => {
                const empId = v.employee_id;
                if (!stats[empId]) {
                    stats[empId] = { 
                        nom: v.employees.nom, 
                        matricule: v.employees.matricule, 
                        total_visites: 0,
                        lieux: {} 
                    };
                }
                stats[empId].total_visites++;
                const locName = v.mobile_locations.name;
                stats[empId].lieux[locName] = (stats[empId].lieux[locName] || 0) + 1;
            });

            return res.json(Object.values(stats));
        }
                




                
else if (action === 'check-returns') {

                if (!req.user.permissions || !req.user.permissions.can_send_announcements) { // Car le robot envoie des flash_messages
                return res.status(403).json({ error: "Accès refusé au robot de surveillance" });
            }
    
            const now = new Date();
            const todayStr = now.toISOString().split('T')[0];
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toISOString().split('T')[0];

            const { data: retoursAttendus } = await supabase
                .from('conges')
                .select('employee_id, employees_nom, date_fin')
                .eq('statut', 'Validé')
                .eq('date_fin', yesterdayStr);

            if (retoursAttendus && retoursAttendus.length > 0) {
                const alertes = [];
                for (const retour of retoursAttendus) {
                    const { data: pointageToday } = await supabase
                        .from('pointages')
                        .select('id')
                        .eq('employee_id', retour.employee_id)
                        .gte('heure', `${todayStr}T00:00:00`)
                        .limit(1);

                    if (!pointageToday || pointageToday.length === 0) {
                        // --- VÉRIFICATION DOUBLON ---
                        // On vérifie si un message d'alerte n'existe pas déjà pour aujourd'hui
                        const { data: exist } = await supabase
                            .from('flash_messages')
                            .select('id')
                            .ilike('message', `%${retour.employees_nom}%`)
                            .gte('created_at', `${todayStr}T00:00:00`);

                        if (!exist || exist.length === 0) {
                            await supabase.from('flash_messages').insert([{
                                message: `ALERTE RETOUR : ${retour.employees_nom} absent au poste après congés.`,
                                type: 'Urgent',
                                sender: 'Robot SIRH',
                                date_expiration: new Date(now.getTime() + 7200000).toISOString() // Expire dans 2h
                            }]);
                        }
                        alertes.push({ message: `Alerte générée pour ${retour.employees_nom}` });
                    }
                }
                return res.json({ status: "checked", alerts: alertes });
            }
            return res.json({ status: "success", message: "Rien à signaler" });
        }







// --- AJOUTER UN PRODUIT ---
else if (action === 'add-product') {
if (!checkPerm(req, 'can_manage_catalog')) return res.status(403).json({ error: "Droits de gestion catalogue requis." });
    
    const { name, description } = req.body;
    let photoUrl = null;
    if (req.files && req.files.length > 0) {
        const file = req.files[0];
        const fileName = `prod_${Date.now()}.jpg`;
        const { error } = await supabase.storage.from('documents').upload(fileName, file.buffer);
        if (!error) photoUrl = supabase.storage.from('documents').getPublicUrl(fileName).data.publicUrl;
    }
    const { error } = await supabase.from('products').insert([{ name, description, photo_url: photoUrl }]);
    if (error) throw error;
    return res.json({ status: "success" });
}





    // --- AJOUTER UN PRESCRIPTEUR (ADMIN/MANAGER) ---
        else if (action === 'add-prescripteur') {
        if (!checkPerm(req, 'can_manage_prescripteurs')) {
            return res.status(403).json({ error: "Accès refusé : Vous n'êtes pas autorisé à créer des prescripteurs." });
        }

            const { nom_complet, fonction, telephone, location_id } = req.body;

            // On vérifie si un médecin avec ce nom existe déjà (pour éviter les doublons)
            const { data: exist } = await supabase
                .from('prescripteurs')
                .select('id')
                .ilike('nom_complet', nom_complet)
                .maybeSingle();

            if (exist) {
                return res.status(400).json({ error: "Ce prescripteur existe déjà dans la base." });
            }

            const { error } = await supabase.from('prescripteurs').insert([{
                nom_complet,
                fonction,
                telephone,
                location_id: location_id || null,
                is_active: true
            }]);

            if (error) throw error;
            return res.json({ status: "success" });
        }

        // --- SUPPRIMER (DÉSACTIVER) UN PRESCRIPTEUR ---
        else if (action === 'delete-prescripteur') {
            if (!req.user.permissions || !req.user.permissions.can_manage_config) {
                return res.status(403).json({ error: "Accès refusé." });
            }
            const { id } = req.body;
            // On ne supprime pas physiquement pour garder l'historique des rapports, on désactive
            const { error } = await supabase.from('prescripteurs').update({ is_active: false }).eq('id', id);
            
            if (error) throw error;
            return res.json({ status: "success" });
        }
            

            // --- MODIFIER UN PRESCRIPTEUR ---
        else if (action === 'update-prescripteur') {
            if (!req.user.permissions || !req.user.permissions.can_manage_config) {
                return res.status(403).json({ error: "Accès refusé." });
            }

            const { id, nom_complet, fonction, telephone, location_id } = req.body;

            const { error } = await supabase
                .from('prescripteurs')
                .update({
                    nom_complet,
                    fonction,
                    telephone,
                    location_id: location_id || null
                })
                .eq('id', id);

            if (error) throw error;
            return res.json({ status: "success" });
        }
            
    // --- LISTER LES PRESCRIPTEURS OFFICIELS ---
else if (action === 'list-prescripteurs') {
    try {
        const { data, error } = await supabase
            .from('prescripteurs')
            .select('*')
            .eq('is_active', true)
            .order('nom_complet', { ascending: true });

        if (error) throw error;
        return res.json(data);
    } catch (err) {
        console.error("Erreur list-prescripteurs:", err.message);
        return res.status(500).json({ error: err.message });
    }
}
    
// --- LISTER LES PRODUITS ---
else if (action === 'list-products') {
    const { data, error } = await supabase.from('products').select('*').eq('is_active', true).order('name');
    if (error) throw error;
    return res.json(data);
}

// --- SUPPRIMER UN PRODUIT (Désactivation) ---
else if (action === 'delete-product') {
    const { id } = req.body;
    const { error } = await supabase.from('products').update({ is_active: false }).eq('id', id);
    if (error) throw error;
    return res.json({ status: "success" });
}







    // 5. CRÉATION PROFIL (WRITE)
else if (action === 'write') {
    if (!checkPerm(req, 'can_create_profiles')) {
        return res.status(403).json({ error: "Accès refusé à la création de profils" });
    }


    // NETTOYAGE DES DOUBLONS (Sécurité)
    // Si contract_template_id arrive sous forme de tableau, on ne prend que le premier élément
    if (Array.isArray(req.body.contract_template_id)) {
        req.body.contract_template_id = req.body.contract_template_id[0];
    }
    
    const body = req.body;
    console.log("📥 Création profil pour :", body.nom);

    let uploadedDocs = { photo_url: null, id_card_url: null, cv_url: null, diploma_url: null, attestation_url: null };

    // --- A. GESTION DES FICHIERS (Multer) --- (CE BLOC RESTE INCHANGÉ)
    if (req.files && req.files.length > 0) {
        for (const file of req.files) {
            const fileName = `${Date.now()}_${file.originalname.replace(/\s/g, '_')}`;
            const { error } = await supabase.storage.from('documents').upload(fileName, file.buffer, { contentType: file.mimetype });
            if (!error) {
                const { data } = supabase.storage.from('documents').getPublicUrl(fileName);
                if (file.fieldname === 'photo') uploadedDocs.photo_url = data.publicUrl;
                if (file.fieldname === 'id_card') uploadedDocs.id_card_url = data.publicUrl;
                if (file.fieldname === 'cv') uploadedDocs.cv_url = data.publicUrl;
                if (file.fieldname === 'diploma') uploadedDocs.diploma_url = data.publicUrl;
                if (file.fieldname === 'attestation') uploadedDocs.attestation_url = data.publicUrl;
            }
        }
    }

    const generatedPassword = Math.random().toString(36).slice(-8) + "!23";
    
    // --- B. CRÉATION DANS APP_USERS --- (CE BLOC RESTE INCHANGÉ)
    const { data: newUser, error: uErr } = await supabase
        .from('app_users')
        .insert([{ 
            email: body.email, 
            password: generatedPassword, 
            nom_complet: body.nom 
        }])
        .select().single();

    if (uErr) {
        console.error("Erreur app_users:", uErr.message);
        return res.json({ error: "Email déjà utilisé ou erreur base de données" });
    }
    
    // --- C. GÉNÉRATION DU MATRICULE ROBUSTE (Anti-doublon) ---
            const { data: nextMatricule, error: seqErr } = await supabase.rpc('get_next_formatted_matricule');
            if (seqErr) throw new Error("Erreur de génération de matricule");
            // -----------------------------------------------------
          const daysLimit = body.limit || '365'; // Récupère la durée choisie (90, 180, 365)


    // --- D. INSERTION DANS EMPLOYEES (AVEC LES NOUVEAUX CHAMPS CONTRACTUELS) ---
    const { data: newEmp, error: empErr } = await supabase.from('employees').insert([{
        user_associated_id: newUser.id, 
        matricule: nextMatricule,
        nom: body.nom,
        email: body.email, 
        telephone: body.telephone,
        adresse: body.adresse, 
        poste: body.poste, 
        departement: body.dept, 
        role: body.role || 'EMPLOYEE', 
        employee_type: body.employee_type || 'OFFICE',
        statut: 'Actif',
        date_embauche: body.date,
        date_fin_contrat: getEndDate(body.date, daysLimit), 
        type_contrat: body.limit === '365' ? 'CDI' : (body.limit === '180' ? 'CDD' : 'Essai'),
        solde_conges: 25,
        photo_url: uploadedDocs.photo_url,
        id_card_url: uploadedDocs.id_card_url,
        cv_url: uploadedDocs.cv_url, 
        diploma_url: uploadedDocs.diploma_url, 
        attestation_url: uploadedDocs.attestation_url,
        manager_id: body.manager_id === "" ? null : body.manager_id,
        management_scope: body.scope ? JSON.parse(body.scope) : [],
        civilite: body.civilite,
        salaire_brut_fixe: parseFloat(body.salaire_fixe) || 0,
        indemnite_transport: parseFloat(body.indemnite_transport) || 0,
        indemnite_logement: parseFloat(body.indemnite_logement) || 0, // Ajouté si le front le fournit
        temps_travail: body.temps_travail,
        duree_essai: body.duree_essai,
        lieu_signature: body.lieu_signature,
        contract_template_id: (body.contract_template_id && body.contract_template_id !== "") ? body.contract_template_id : null,
        lieu_naissance: body.lieu_naissance,
        nationalite: body.nationalite
    }]).select().single();

    if (empErr) {
        console.error("Erreur employees:", empErr.message);
        throw empErr;
    }

    // --- E. CALCUL DU HIERARCHY_PATH --- (CE BLOC RESTE INCHANGÉ)
    let path = String(newEmp.id);
    if (body.manager_id && body.manager_id !== "") {
        const { data: manager } = await supabase.from('employees').select('hierarchy_path').eq('id', body.manager_id).single();
        if (manager && manager.hierarchy_path) {
            path = `${manager.hierarchy_path}/${newEmp.id}`;
        }
    }
    await supabase.from('employees').update({ hierarchy_path: path }).eq('id', newEmp.id);

    // --- F. ENVOI DE L'EMAIL DE BIENVENUE --- (CE BLOC RESTE INCHANGÉ)
    const emailSujet = `Bienvenue chez SIRH SECURE - Vos accès`;
    const emailHtml = `
        <div style="font-family: Arial, sans-serif; color: #333;">
            <h2>Félicitations ${body.nom} !</h2>
            <p>Votre profil collaborateur a été créé avec succès.</p>
            <p>Voici vos identifiants pour accéder à votre espace :</p>
            <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; border: 1px solid #ddd;">
                <p>🔗 <b>Lien :</b> <a href="https://dom4002.github.io/sirh-supabase-v2-frontend/">Accéder au Portail</a></p>
                <p>👤 <b>Identifiant :</b> ${body.email}</p>
                <p>🔑 <b>Mot de passe :</b> ${generatedPassword}</p>
            </div>
            <p style="color: #666; font-size: 12px; margin-top: 20px;">Ceci est un message automatique, merci de ne pas y répondre.</p>
        </div>`;

    await sendEmailAPI(body.email, emailSujet, emailHtml);

    return res.json({ status: "success" });
}


    

        // ============================================================
        // 16. LECTURE DES ANNONCES (FLASH MESSAGES) ✅
        // ============================================================
        else if (action === 'read-flash') {
            const now = new Date().toISOString();

            // On récupère uniquement les messages non expirés
            const { data, error } = await supabase
                .from('flash_messages')
                .select('*')
                .gt('date_expiration', now)
                .order('created_at', { ascending: false });

            if (error) throw error;

            // On mappe pour que le Frontend reçoive les noms attendus
            const mapped = data.map(m => ({
                Message: m.message,
                Sender: m.sender,
                Type: m.type,
                Date: m.created_at,
                id: m.id
            }));

            return res.json(mapped);
        }

        // ============================================================
        // 17. PUBLICATION D'UNE ANNONCE ✅
        // ============================================================
        else if (action === 'write-flash') {

                if (!req.user.permissions || !req.user.permissions.can_send_announcements) {
                return res.status(403).json({ error: "Accès refusé à la diffusion d'annonces" });
                }
                            
            const { message, type, sender, date_expiration } = req.body;

            const { error } = await supabase
                .from('flash_messages')
                .insert([{ 
                    message, 
                    type, 
                    sender, 
                    date_expiration 
                }]);

            if (error) throw error;

            console.log(`📢 Nouvelle annonce de ${sender} : ${message.substring(0, 30)}...`);
            return res.json({ status: "success" });
        }




// A. DEMANDER UN CODE (VERSION SÉCURISÉE)
        else if (action === 'request-password-reset') {
            const email = req.body.email ? req.body.email.toLowerCase().trim() : "";
            const code = Math.floor(100000 + Math.random() * 900000).toString(); 
            const expires = new Date(Date.now() + 15 * 60000).toISOString(); // On réduit à 15 min (plus sûr)

            // 1. On tente de mettre à jour l'utilisateur s'il existe
            const { data: user, error } = await supabase
                .from('app_users')
                .update({ reset_code: code, reset_expires: expires })
                .eq('email', email)
                .select('nom_complet')
                .maybeSingle();

            // 2. S'il existe, on envoie le mail
            if (user) {
                const html = `
                    <div style="font-family: sans-serif; color: #1e293b; padding: 20px; border: 1px solid #e2e8f0; border-radius: 15px;">
                        <h2 style="color: #2563eb;">Sécurité SIRH</h2>
                        <p>Bonjour <b>${user.nom_complet}</b>,</p>
                        <p>Vous avez demandé la réinitialisation de votre mot de passe. Voici votre code de vérification :</p>
                        <div style="background: #f1f5f9; padding: 15px; text-align: center; font-size: 24px; font-weight: 900; letter-spacing: 5px; color: #0f172a; border-radius: 10px; margin: 20px 0;">
                            ${code}
                        </div>
                        <p style="font-size: 12px; color: #64748b;">Ce code expirera dans 15 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.</p>
                    </div>`;
                
                await sendEmailAPI(email, "Code de sécurité SIRH", html);
            }

            // 3. ON RÉPOND TOUJOURS SUCCÈS (Pour brouiller les pistes des pirates)
            return res.json({ status: "success", message: "Procédure lancée." });
        }

        // B. VALIDER LE CHANGEMENT (VERSION BLINDÉE)
        else if (action === 'reset-password') {
            const { email, code, newPassword } = req.body;
            const cleanEmail = email.toLowerCase().trim();

            // 1. Vérification stricte : Email + Code + Expiration
            const { data: user, error } = await supabase
                .from('app_users')
                .select('id')
                .eq('email', cleanEmail)
                .eq('reset_code', code)
                .gt('reset_expires', new Date().toISOString())
                .maybeSingle();

            if (!user) {
                return res.status(400).json({ error: "Code invalide ou expiré." });
            }

            // 2. Mise à jour du mot de passe ET destruction du code
            const { error: updateErr } = await supabase
                .from('app_users')
                .update({
                    password: newPassword,
                    reset_code: null,    // On efface le code pour qu'il ne resserve plus
                    reset_expires: null  // On efface l'expiration
                })
                .eq('id', user.id);

            if (updateErr) throw updateErr;

            // 3. Log de sécurité
            await supabase.from('logs').insert([{ 
                agent: 'Système', 
                action: 'SÉCURITÉ', 
                details: `Mot de passe réinitialisé pour : ${cleanEmail}` 
            }]);

            return res.json({ status: "success" });
        }


                      
else if (action === 'delete-template') {
    const { id } = req.body;
    
    // On ne supprime pas (DELETE), on désactive (UPDATE)
    // Cela permet de garder l'historique pour les anciens employés
    const { error } = await supabase
        .from('contract_templates')
        .update({ is_active: false }) 
        .eq('id', id);

    if (error) throw error;
    return res.json({ status: "success", message: "Modèle archivé" });
}

        // ============================================================
        // 6. MODULE DES CONGÉS (NOUVEAU ✅)
        // ============================================================
        
        // A. Demande de congé par l'employé
        else if (action === 'leave') {
            const b = req.body;
            let justifUrl = null;

            const justifFile = req.files.find(f => f.fieldname === 'justificatif');
            if (justifFile) {
                const fileName = `justif_${Date.now()}_${justifFile.originalname}`;
                await supabase.storage.from('documents').upload(fileName, justifFile.buffer);
                justifUrl = supabase.storage.from('documents').getPublicUrl(fileName).data.publicUrl;
            }

            const { error } = await supabase.from('conges').insert([{
                employee_id: b.employee_id,
                type: b.type,
                date_debut: b.date_debut,
                date_fin: b.date_fin,
                motif: b.motif,
                employees_nom: b.nom,
                justificatif_url: justifUrl,
                statut: 'En attente'
            }]);

            if (error) throw error;
            return res.json({ status: "success" });
        }










// ============================================================
// 15. GÉNÉRATION DES BULLETINS DE PAIE (DESIGN PREMIUM PDF) ✅
// ============================================================
else if (action === 'process-payroll') {
    if (!checkPerm(req, 'can_see_payroll')) return res.status(403).json({ error: "Accès refusé" });

    const { payrollRecords } = req.body; 

    try {
        for (const record of payrollRecords) {
            // Formatage des montants pour le design (ex: 1 500 000 CFA)
            const fmt = (val) => new Intl.NumberFormat('fr-FR').format(val || 0) + " CFA";

// Dans server.js, boucle record of payrollRecords
const cnssPart = Math.round(record.salaire_base * (record.taux_cnss / 100));
const irppPart = record.retenues - cnssPart; // On déduit l'IRPP du reste des retenues

const htmlSlip = `
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <style>
        @page { size: A4; margin: 0; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; margin: 0; padding: 0; }
        .page { width: 210mm; min-height: 297mm; padding: 15mm; margin: auto; box-sizing: border-box; }
        
        .header { display: flex; justify-content: space-between; border-bottom: 2px solid #334155; padding-bottom: 10px; margin-bottom: 20px; }
        .logo-box { font-size: 24px; font-weight: 800; color: #0f172a; }
        .title-box { text-align: right; }
        
        .info-grid { display: flex; gap: 10px; margin-bottom: 20px; }
        .info-card { flex: 1; border: 1px solid #e2e8f0; padding: 10px; border-radius: 8px; font-size: 11px; }
        .label { font-size: 8px; color: #64748b; text-transform: uppercase; font-weight: bold; }
        
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 11px; }
        th { background: #f8fafc; border: 1px solid #e2e8f0; padding: 8px; text-align: left; }
        td { border: 1px solid #e2e8f0; padding: 8px; }
        
        .row-total { background: #f1f5f9; font-weight: bold; }
        .net-box { margin-top: 20px; background: #2563eb; color: white; padding: 15px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; }
        .net-amount { font-size: 22px; font-weight: 900; }
        .footer { font-size: 9px; color: #94a3b8; text-align: center; margin-top: 30px; border-top: 1px solid #f1f5f9; padding-top: 10px; }
    </style>
</head>
<body>
    <div class="page">
        <div class="header">
            <div class="logo-box">SIRH SECURE</div>
            <div class="title-box">
                <h2 style="margin:0; font-size:16px;">BULLETIN DE PAIE</h2>
                <p style="margin:0; font-size:10px;">Période : ${record.mois} ${record.annee}</p>
            </div>
        </div>

        <div class="info-grid">
            <div class="info-card">
                <span class="label">Employeur</span><br>
                <strong>SIRH-SECURE SOLUTIONS</strong><br>Cotonou, Bénin
            </div>
            <div class="info-card">
                <span class="label">Salarié</span><br>
                <strong>${record.nom}</strong><br>
                Matricule: ${record.matricule}<br>
                Poste: ${record.poste}
            </div>
        </div>

        <table>
            <thead>
                <tr>
                    <th>Désignation</th>
                    <th>Base / Taux</th>
                    <th style="text-align:right">Gains</th>
                    <th style="text-align:right">Retenues</th>
                </tr>
            </thead>
            <tbody>
                <!-- GAINS -->
                <tr>
                    <td>Salaire de base</td>
                    <td>100%</td>
                    <td style="text-align:right">${fmt(record.salaire_base)}</td>
                    <td></td>
                </tr>
                <tr>
                    <td>Indemnités contractuelles (Logement/Transp.)</td>
                    <td>Fixe</td>
                    <td style="text-align:right">${fmt(record.indemnites_fixes)}</td>
                    <td></td>
                </tr>
                <tr>
                    <td>Primes et gratifications</td>
                    <td>Variable</td>
                    <td style="text-align:right">${fmt(record.primes)}</td>
                    <td></td>
                </tr>
                
                <!-- RETENUES EXPLICITES -->
                <tr>
                    <td>Cotisation Sociale (CNSS)</td>
                    <td>${record.taux_cnss}%</td>
                    <td></td>
                    <td style="text-align:right">${fmt(cnssPart)}</td>
                </tr>
                <tr>
                    <td>Impôt sur le Revenu (IRPP)</td>
                    <td>${record.taux_irpp}% (est.)</td>
                    <td></td>
                    <td style="text-align:right">${fmt(irppPart)}</td>
                </tr>

                <tr class="row-total">
                    <td>TOTAUX</td>
                    <td></td>
                    <td style="text-align:right">${fmt(record.salaire_base + record.indemnites_fixes + record.primes)}</td>
                    <td style="text-align:right">${fmt(record.retenues)}</td>
                </tr>
            </tbody>
        </table>

        <div class="net-box">
            <span style="font-weight:bold; text-transform:uppercase;">Net à percevoir</span>
            <span class="net-amount">${fmt(record.salaire_net)}</span>
        </div>

        <div class="footer">
            Bulletin de paie numérique généré le ${new Date().toLocaleDateString('fr-FR')}<br>
            Pour faire valoir ce que de droit.
        </div>
    </div>
</body>
</html>`;

            // 2. CONVERSION VECTORIELLE (HTML -> PDF via LibreOffice)
            const htmlBuffer = Buffer.from(htmlSlip, 'utf-8');
            
            console.log("🔄 Conversion PDF Vectoriel pour :", record.nom);
            const pdfBuffer = await convertAsync(htmlBuffer, '.pdf', undefined);

            const fileName = `bulletin_${record.id}_${Date.now()}.pdf`;
            
            // 3. UPLOAD SUR SUPABASE STORAGE
            await supabase.storage.from('documents').upload(fileName, pdfBuffer, { 
                contentType: 'application/pdf', 
                upsert: true 
            });
            
            const { data: publicData } = supabase.storage.from('documents').getPublicUrl(fileName);

            // 4. INSERTION DANS LA TABLE PAIE
            await supabase.from('paie').insert([{
                employee_id: record.id, 
                mois: record.mois, 
                annee: parseInt(record.annee),
                salaire_base: parseInt(record.salaire_base), 
                primes: parseInt(record.primes),
                retenues: parseInt(record.retenues), 
                salaire_net: parseInt(record.salaire_net),
                fiche_pdf_url: publicData.publicUrl
            }]);
        }
        return res.json({ status: "success" });
    } catch (err) { 
        console.error("❌ Erreur Paie:", err.message);
        return res.status(500).json({ error: "Erreur lors de la génération des bulletins PDF." }); 
    }
}


// ============================================================
        // 19. GESTION DES BUREAUX (ADAPTÉ À TA TABLE SUPABASE) ✅
        // ============================================================
        else if (action === 'add-zone') {

            if (!req.user.permissions || !req.user.permissions.can_manage_config) {
                return res.status(403).json({ error: "Accès refusé à la configuration" });
            }
            
            const { nom, lat, lon, rayon } = req.body;
            
            // On utilise les noms exacts de tes colonnes : latitude et longitude
            const { error } = await supabase.from('zones').insert([{
                nom: nom,
                latitude: parseFloat(lat),
                longitude: parseFloat(lon),
                rayon: parseInt(rayon),
                actif: true
            }]);
            
            if (error) {
                console.error("Erreur ajout zone:", error.message);
                throw error;
            }
            return res.json({ status: "success" });
        }

        else if (action === 'delete-zone') {

            if (!req.user.permissions || !req.user.permissions.can_manage_config) {
                return res.status(403).json({ error: "Accès refusé à la configuration" });
            }
            
            const { id } = req.body;
            const { error } = await supabase.from('zones').delete().eq('id', id);
            if (error) throw error;
            return res.json({ status: "success" });
        }

        else if (action === 'list-zones') {

             if (!req.user.permissions || !req.user.permissions.can_manage_config) {
                return res.status(403).json({ error: "Accès refusé à la configuration" });
            }
            
            const { data, error } = await supabase
                .from('zones')
                .select('*')
                .order('created_at', { ascending: false });
                
            if (error) throw error;
            return res.json(data);
        }




       // ============================================================
        // GESTION DES LIEUX MOBILES (PHARMACIES, SITES DE GARDE) ✅
        // ============================================================

        // A. Ajouter un nouveau lieu mobile
        else if (action === 'add-mobile-location') {
            if (!checkPerm(req, 'can_manage_prescripteurs')) {
                return res.status(403).json({ error: "Accès refusé : Vous n'êtes pas autorisé à créer des prescripteurs." });
            }
            const { name, address, latitude, longitude, radius, type_location } = req.body;
            const { data, error } = await supabase.from('mobile_locations').insert([{
                name, address, latitude: parseFloat(latitude), longitude: parseFloat(longitude), radius: parseInt(radius), type_location
            }]).select();
            if (error) throw error;
            return res.json({ status: "success", data: data[0] });
        }

        // B. Lister tous les lieux mobiles
        else if (action === 'list-mobile-locations') {
            // Peut être vu par ceux qui gèrent les employés ou la config
            if (!req.user.permissions || (!req.user.permissions.can_manage_config && !req.user.permissions.can_see_employees)) {
                return res.status(403).json({ error: "Accès refusé aux lieux mobiles" });
            }
            const { data, error } = await supabase.from('mobile_locations').select('*').order('name', { ascending: true });
            if (error) throw error;
            return res.json(data);
        }

        // C. Mettre à jour un lieu mobile
        else if (action === 'update-mobile-location') {
            if (!req.user.permissions || !req.user.permissions.can_manage_config) {
                return res.status(403).json({ error: "Accès refusé à la modification des lieux mobiles" });
            }
            const { id, name, address, latitude, longitude, radius, type_location, is_active } = req.body;
            const { data, error } = await supabase.from('mobile_locations').update({
                name, address, latitude: parseFloat(latitude), longitude: parseFloat(longitude), radius: parseInt(radius), type_location, is_active
            }).eq('id', id).select();
            if (error) throw error;
            return res.json({ status: "success", data: data[0] });
        }

        // D. Supprimer un lieu mobile
        else if (action === 'delete-mobile-location') {
            if (!req.user.permissions || !req.user.permissions.can_manage_config) {
                return res.status(403).json({ error: "Accès refusé à la suppression des lieux mobiles" });
            }
            const { id } = req.body;
            const { error } = await supabase.from('mobile_locations').delete().eq('id', id);
            if (error) throw error;
            return res.json({ status: "success" });
        }






          // ============================================================
        // GESTION DES PLANNINIGS D'EMPLOYÉS MOBILES ✅
        // ============================================================

        // A. Ajouter un planning (Auto-planification Délégué OU Assignation Manager)
        else if (action === 'add-schedule') {
            // Tout le monde peut planifier (Délégué pour lui-même, Chef pour les autres)
            
            const { employee_id, location_id, schedule_date, start_time, end_time, notes, prescripteur_id } = req.body;
            
            // SÉCURITÉ : Si je suis un simple employé, je ne peux planifier QUE pour moi-même
            if (!req.user.permissions.can_see_employees && String(employee_id) !== String(req.user.emp_id)) {
                return res.status(403).json({ error: "Vous ne pouvez planifier que pour vous-même." });
            }

            const { data, error } = await supabase.from('employee_schedules').insert([{
                employee_id, 
                location_id: location_id || null, 
                prescripteur_id: prescripteur_id || null, // <--- NOUVEAU
                schedule_date, 
                start_time, 
                end_time, 
                notes,
                status: 'PENDING' // Statut par défaut : En attente
            }]).select();

            if (error) throw error;
            return res.json({ status: "success", data: data[0] });
        }

        // B. Lister les plannings (avec détails de l'employé et du lieu)
        else if (action === 'list-schedules') {
            // Un employé mobile ne voit que ses propres plannings
            // Un RH/Admin/Manager voit tous les plannings
            const isMobileEmployee = req.user.employee_type && req.user.employee_type !== 'OFFICE';
            const canSeeAllSchedules = req.user.permissions && req.user.permissions.can_see_employees;

                let query = supabase
                .from('employee_schedules')
                .select(`
                    *, 
                    employees(id, nom, matricule, employee_type, poste), 
                    mobile_locations(id, name, address, latitude, longitude, radius, type_location),
                    prescripteurs(id, nom_complet, fonction)
                `) // <--- J'ai ajouté la liaison avec prescripteurs
                .order('schedule_date', { ascending: false })
                .order('start_time', { ascending: true });

            if (!canSeeAllSchedules && isMobileEmployee) {
                query = query.eq('employee_id', req.user.emp_id);
            } else if (!canSeeAllSchedules && !isMobileEmployee) {
                // Si ce n'est pas un RH/Admin et pas un employé mobile, il ne devrait pas voir cette route
                return res.status(403).json({ error: "Accès refusé aux plannings" });
            }

            const { data, error } = await query;
            if (error) throw error;

            // Mapping pour faciliter l'usage frontend
            const mappedSchedules = data.map(s => ({
                id: s.id,
                employee_id: s.employee_id,
                employee_name: s.employees ? s.employees.nom : 'N/A',
                employee_matricule: s.employees ? s.employees.matricule : 'N/A',
                employee_type: s.employees ? s.employees.employee_type : 'N/A',
                location_id: s.location_id,
                location_name: s.mobile_locations ? s.mobile_locations.name : 'Lieu Inconnu',
                prescripteur_nom: s.prescripteurs ? s.prescripteurs.nom_complet : null,
                prescripteur_fonction: s.prescripteurs ? s.prescripteurs.fonction : null,
                location_address: s.mobile_locations ? s.mobile_locations.address : 'N/A',
                location_lat: s.mobile_locations ? s.mobile_locations.latitude : null,
                location_lon: s.mobile_locations ? s.mobile_locations.longitude : null,
                location_radius: s.mobile_locations ? s.mobile_locations.radius : null,
                schedule_date: s.schedule_date,
                start_time: s.start_time,
                end_time: s.end_time,
                status: s.status,
                notes: s.notes
            }));
            
            return res.json(mappedSchedules);
        }

        // C. Mettre à jour un planning
        else if (action === 'update-schedule') {
            if (!req.user.permissions || !req.user.permissions.can_see_employees) {
                return res.status(403).json({ error: "Accès refusé à la modification de plannings" });
            }
            const { id, employee_id, location_id, schedule_date, start_time, end_time, status, notes } = req.body;
            const { data, error } = await supabase.from('employee_schedules').update({
                employee_id, location_id, schedule_date, start_time, end_time, status, notes, updated_at: new Date().toISOString()
            }).eq('id', id).select();
            if (error) throw error;
            return res.json({ status: "success", data: data[0] });
        }

// D. Supprimer un planning (Manager OU Propriétaire du planning)
        else if (action === 'delete-schedule') {
            const { id } = req.body;
            const currentUserId = req.user.emp_id;
            const isManager = req.user.permissions && req.user.permissions.can_see_employees;

            // 1. On récupère le planning pour voir à qui il appartient
            const { data: schedule } = await supabase
                .from('employee_schedules')
                .select('employee_id')
                .eq('id', id)
                .single();

            if (!schedule) return res.status(404).json({ error: "Mission introuvable" });

            // 2. Vérification : Est-ce que j'ai le droit ?
            // J'ai le droit SI je suis Manager OU SI c'est mon propre ID
            if (!isManager && String(schedule.employee_id) !== String(currentUserId)) {
                return res.status(403).json({ error: "Vous ne pouvez pas supprimer le planning d'un collègue." });
            }

            const { error } = await supabase.from('employee_schedules').delete().eq('id', id);
            if (error) throw error;
            return res.json({ status: "success" });
        }
          

else if (action === 'read-payroll') {
    const { employee_id } = req.query;

    if (!employee_id) {
        return res.status(400).json({ error: "ID employé manquant" });
    }

    // 1. IDENTIFICATION DU CONTEXTE
    // On compare l'ID demandé avec l'ID stocké dans le Token JWT
    const isMe = String(req.user.emp_id) === String(employee_id);

    // 2. VÉRIFICATION DES DROITS (SÉCURITÉ SaaS)
    if (isMe) {
        // Cas : L'employé veut voir ses propres bulletins
        if (!checkPerm(req, 'can_view_own_payroll')) {
            return res.status(403).json({ error: "Accès à vos bulletins de paie désactivé par l'administration." });
        }
    } else {
        // Cas : Un manager ou RH veut voir le bulletin d'un autre
        if (!checkPerm(req, 'can_see_payroll')) {
            return res.status(403).json({ error: "Accès refusé : Vous n'avez pas le droit de consulter la paie des collaborateurs." });
        }
    }
    
    // 3. RÉCUPÉRATION DES DONNÉES
    try {
        const { data, error } = await supabase
            .from('paie')
            .select('*, employees(nom, poste)') 
            .eq('employee_id', employee_id)
            // On trie par année puis par mois pour avoir les plus récents en haut
            .order('annee', { ascending: false });

        if (error) throw error;

        return res.json(data);

    } catch (err) {
        console.error("Erreur read-payroll:", err.message);
        return res.status(500).json({ error: "Erreur lors de la récupération des bulletins." });
    }
}




                
// ============================================================
        // 20. LIVE TRACKER : INCLUSION DES GENS EN CONGÉ ET EN POSTE ✅
        // ============================================================
        else if (action === 'live-attendance') {
            try {
                const todayStr = new Date().toISOString().split('T')[0];
                const currentUserId = req.user.emp_id;

                // 1. Récupérer le périmètre du manager
                const { data: requester } = await supabase.from('employees')
                    .select('hierarchy_path, management_scope')
                    .eq('id', currentUserId).single();

                // 2. Construire la requête filtrée pour les employés
                // MODIFICATION : On ajoute "En Poste" à la liste des statuts suivis
                let empQuery = supabase.from('employees')
                    .select('id, nom, poste, photo_url, statut, hierarchy_path')
                    .or('statut.eq.Actif,statut.eq.Congé,statut.eq.En Poste');

                if (!checkPerm(req, 'can_see_employees')) {
                    let conditions = [];
                    conditions.push(`hierarchy_path.eq.${requester.hierarchy_path}`);
                    conditions.push(`hierarchy_path.ilike.${requester.hierarchy_path}/%`);
                    if (requester.management_scope?.length > 0) {
                        const scopeList = `(${requester.management_scope.map(s => `"${s}"`).join(',')})`;
                        conditions.push(`departement.in.${scopeList}`);
                    }
                    empQuery = empQuery.or(conditions.join(','));
                }

                const { data: emps } = await empQuery;

                // 3. Récupérer les pointages du jour
                const { data: pointages } = await supabase.from('pointages')
                    .select('*').gte('heure', `${todayStr}T00:00:00`);

                const status = { presents: [], partis: [], absents: [] };

        // Dans server.js, route 'live-attendance'
        if (emps) {
            emps.forEach(e => {
                const sesPointages = (pointages || []).filter(p => p.employee_id === e.id);
                
                if (sesPointages.length === 0) {
                    status.absents.push(e);
                } else {
                    // Source de vérité : Le dernier pointage enregistré
                    const dernier = sesPointages[sesPointages.length - 1];
        
                    // RÈGLE UNIVERSELLE :
                    // Si le dernier geste est une SORTIE et que c'est marqué comme FINAL
                    if (dernier.action === 'CLOCK_OUT' && (dernier.is_final_out === true || dernier.is_final_out === 'true')) {
                        status.partis.push(e); // Direction -> Carte Bleue (Journée terminée)
                    } 
                    // Si le dernier geste est une ENTRÉE
                    else if (dernier.action === 'CLOCK_IN') {
                        status.presents.push(e); // Direction -> Carte Verte (En poste)
                    }
                    // Cas Mobile : Sortie de pharmacie mais pas fin de journée
                    else {
                        status.presents.push(e); // Reste en Vert (En poste) car il va vers une autre pharmacie
                    }
                }
            });
        }
                return res.json(status);
            } catch (err) { return res.status(500).json({ error: err.message }); }
        }




        
// ============================================================
        // 11. MODULE CHAT (MESSAGERIE) ✅
        // ============================================================
        
        // A. Lire les messages
        else if (action === 'read-messages') {
            // On récupère les 50 derniers messages + les infos de l'expéditeur (nom, photo)
            const { data, error } = await supabase
                .from('messages')
                .select('*, employees(id, nom, photo_url)')
                .order('created_at', { ascending: true }) // Chronologique (anciens -> récents)
                .limit(50);

            if (error) throw error;

            // On formate pour le frontend
            const mapped = data.map(m => ({
                id: m.id,
                message: m.message,
                file: m.file_url,
                date: m.created_at,
                sender_id: m.sender_id,
                // Si l'employé a été supprimé, on met "Inconnu"
                sender_name: m.employees ? m.employees.nom : "Utilisateur supprimé",
                sender_photo: m.employees ? m.employees.photo_url : null
            }));

            return res.json(mapped);
        }

        




        


// ============================================================
        // 11-B. ENVOYER UN MESSAGE (AVEC FICHIER) ✅
        // ============================================================
        else if (action === 'send-message') {
        if (!checkPerm(req, 'can_use_chat')) return res.status(403).json({ error: "Interdit : Accès au chat désactivé." });

            // On force l'utilisation de l'ID du token pour garantir l'identité
            const sender_id = req.user.emp_id; 
            let { message } = req.body;
            message = message.replace(/<[^>]*>?/gm, ''); 

                        
            let fileUrl = null;

            console.log(`💬 Message de ${sender_id} en cours de traitement...`);

            const file = req.files ? req.files.find(f => f.fieldname === 'chat_file') : null;

            if (file) {
                const maxSize = 5 * 1024 * 1024; 
                if (file.size > maxSize) {
                    console.error("❌ Erreur : Fichier trop volumineux.");
                    return res.json({ status: "error", message: "Le fichier est trop lourd (max 5 Mo)." });
                }

                const sanitizedName = file.originalname
                    .normalize("NFD")
                    .replace(/[\u0300-\u036f]/g, "") 
                    .replace(/[^a-z0-9.]/gi, '_');

                const fileName = `chat_${Date.now()}_${sanitizedName}`;
                
                console.log(`📎 Upload du fichier sécurisé : ${fileName}`);

                const { data: uploadData, error: upErr } = await supabase.storage
                    .from('documents')
                    .upload(fileName, file.buffer, { 
                        contentType: file.mimetype,
                        upsert: true 
                    });

                if (upErr) {
                    console.error("❌ Erreur Storage Supabase:", upErr.message);
                } else {
                    const { data: publicData } = supabase.storage
                        .from('documents')
                        .getPublicUrl(fileName);
                    
                    fileUrl = publicData.publicUrl; 
                    console.log("✅ URL générée avec succès :", fileUrl);
                }
            }

            const { error: dbErr } = await supabase
                .from('messages')
                .insert([{
                    sender_id: sender_id,
                    message: message || "", 
                    file_url: fileUrl 
                }]);

            if (dbErr) {
                console.error("❌ Erreur BDD Messages:", dbErr.message);
                return res.status(500).json({ error: dbErr.message });
            }

            return res.json({ status: "success" });
        }






else if (action === 'read-settings') {
            const { data, error } = await supabase
                .from('app_settings')
                .select('*')
                .order('label', { ascending: true });

            if (error) {
                console.error("❌ Erreur lecture settings:", error.message);
                throw error;
            }
            return res.json(data);
        }



else if (action === 'read-modules') {
            // Public pour les utilisateurs connectés (sert à construire le menu)
            const { data } = await supabase.from('company_modules').select('*');
            return res.json(data);
        }
// IMPORT MASSIF DE LIEUX (CSV / JSON)
        else if (action === 'import-locations') {
            if (!req.user.permissions.can_manage_config) return res.status(403).json({ error: "Interdit" });
            
            const { locations } = req.body; // Un tableau d'objets [{name, lat, lon, zone}, ...]
            
            // Insertion massive (Bulk Insert)
            const { error } = await supabase.from('mobile_locations').insert(locations);
            
            if (error) throw error;
            return res.json({ status: "success", count: locations.length });
        }

        
 
// ============================================================
        // VÉRIFIER L'ÉTAT DU BOUTON (VÉRIF UNIVERSELLE DU FINAL_OUT) ✅
        // ============================================================
        else if (action === 'get-clock-status') {
            const { employee_id } = req.query;
            const now = new Date();
            const todayStr = now.toISOString().split('T')[0];

            // 1. Récupérer le type d'employé
            const { data: emp } = await supabase.from('employees').select('employee_type').eq('id', employee_id).single();
            const isMobile = (emp && emp.employee_type === 'MOBILE');

            // 2. Récupérer le DERNIER pointage
            const { data: lastRecord } = await supabase
                .from('pointages')
                .select('action, heure, is_final_out')
                .eq('employee_id', employee_id)
                .order('heure', { ascending: false })
                .limit(1)
                .maybeSingle();

            let status = 'OUT';
            let isDayFinished = false;

            if (lastRecord) {
                const lastTime = new Date(lastRecord.heure);
                const diffHours = (now - lastTime) / (1000 * 60 * 60);

                if (lastRecord.action === 'CLOCK_IN') {
                    // --- CAS ENTRÉE EN COURS ---
                    if (diffHours < 14) {
                        status = 'IN';
                    } else {
                        status = 'OUT'; // Reset automatique après 14h d'oubli
                    }
                } 
                else if (lastRecord.action === 'CLOCK_OUT') {
                    // --- RÈGLE UNIVERSELLE : SORTIE FINALE (Priorité n°1) ---
                    // Si le champ is_final_out est vrai, peu importe le type (Admin, Mobile, Bureau)
                    if (lastRecord.is_final_out === true || lastRecord.is_final_out === 'true') {
                        if (diffHours < 12) {
                            status = 'DONE';
                            isDayFinished = true;
                        } else {
                            status = 'OUT'; // Après 12h, on permet de recommencer une journée
                        }
                    }
                    // --- RÈGLE BUREAU (Auto-clôture au changement de jour) ---
                    else if (!isMobile && lastTime.toISOString().split('T')[0] === todayStr) {
                        status = 'DONE';
                        isDayFinished = true;
                    }
                    else {
                        // Cas Mobile : Sortie de pharmacie "normale", on peut re-pointer Entrée
                        status = 'OUT';
                    }
                }
            }

            return res.json({ 
                status: status, 
                employee_type: emp ? emp.employee_type : 'OFFICE',
                day_finished: isDayFinished
            });
        }


            
        
   
else if (action === 'read-visit-reports') {
    try {
        // Paramètres de pagination
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

    // 1. Initialisation de la requête
            let query = supabase
                .from('visit_reports')
                .select(`
                    *,
                    employees:employee_id (nom),
                    mobile_locations:location_id (name),
                    prescripteurs:prescripteur_id (nom_complet, fonction) 
                `, { count: 'exact' });

        // --- CORRECTION : FILTRE DE SÉCURITÉ POUR LE PROFIL PERSONNEL ---
        // Si l'utilisateur n'est pas Admin, RH ou Manager, il ne peut voir que SES rapports
        const canSeeAll = req.user.permissions && (req.user.permissions.can_view_reports || req.user.role === 'ADMIN' || req.user.role === 'RH');
        
        if (!canSeeAll) {
            console.log(`🔐 Filtrage des rapports pour l'employé : ${req.user.emp_id}`);
            query = query.eq('employee_id', req.user.emp_id);
        }
        // ---------------------------------------------------------------

        // 2. Exécution avec pagination et tri
        const { data, error, count } = await query
            .order('check_in_time', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;

            const cleanData = data.map(v => {
            // Logique intelligente pour le nom du contact (S'il est dans la base ou tapé à la main)
            let doctorName = "Contact non précisé";
            let doctorRole = "";
            
            if (v.prescripteurs && v.prescripteurs.nom_complet) {
                doctorName = v.prescripteurs.nom_complet;
                doctorRole = v.prescripteurs.fonction || "Professionnel de santé";
            } else if (v.contact_nom_libre) {
                doctorName = v.contact_nom_libre;
                doctorRole = "Nouveau contact (Non répertorié)";
            }

            return {
                id: v.id,
                employee_id: v.employee_id,
                nom_agent: v.employees?.nom || "Agent inconnu",
                lieu_nom: v.location_name || v.mobile_locations?.name || "Lieu inconnu",
                contact_nom: doctorName,      
                contact_role: doctorRole,      
                check_in: v.check_in_time,
                check_out: v.check_out_time,
                outcome: v.outcome,
                duration: v.duration_minutes, 
                notes: v.notes,
                proof_url: v.proof_url,
                presented_products: v.presented_products 
            };
        });

        // On renvoie les données ET les infos de pagination
        return res.json({
            data: cleanData,
            meta: {
                total: count,
                page: page,
                last_page: Math.ceil(count / limit)
            }
        });

    } catch (err) {
        console.error("Erreur rapports:", err.message);
        return res.status(500).json({ error: err.message });
    }
}


    
else if (action === 'get-global-audit') {
            const { month, year } = req.query;
            const paddedMonth = String(month).padStart(2, '0');
            const searchPattern = `${year}-${paddedMonth}`; 

            try {
                // --- 1. FILTRE MAGIQUE : On ne prend QUE les employés de type MOBILE ---
                const { data: emps } = await supabase.from('employees')
                    .select('id, nom, matricule, poste')
                    .eq('employee_type', 'MOBILE'); 
                
                const { data: visits } = await supabase.from('visit_reports').select('*');
                const { data: leaves } = await supabase.from('conges').select('*').eq('statut', 'Validé');
                const { data: dailies } = await supabase.from('daily_reports').select('*');

                const auditReport = emps.map(e => {
                    const sesVisites = (visits || []).filter(v => {
                        const dateToCheck = v.check_out_time || v.check_in_time || v.created_at;
                        return v.employee_id === e.id && dateToCheck && dateToCheck.includes(searchPattern);
                    });

                    const statsLieux = {};
                    let totalProduits = 0; // NOUVEAU : Compteur de produits

                    sesVisites.forEach(v => {
                        const name = v.location_name || "Site inconnu";
                        statsLieux[name] = (statsLieux[name] || 0) + 1;

                        // NOUVEAU : On compte combien de produits ont été présentés dans cette visite
                        let prods = [];
                        try {
                            if (typeof v.presented_products === 'string') prods = JSON.parse(v.presented_products);
                            else if (Array.isArray(v.presented_products)) prods = v.presented_products;
                        } catch(err){}
                        totalProduits += prods.length;
                    });

                    const detailLieux = Object.entries(statsLieux)
                        .map(([n, c]) => `${n} (${c})`)
                        .join(', ') || "Aucune visite";

                    const sesConges = (leaves || []).filter(l => l.employee_id === e.id && l.date_debut.includes(searchPattern));
                    let joursAbsence = 0;
                    sesConges.forEach(l => {
                        const d1 = new Date(l.date_debut);
                        const d2 = new Date(l.date_fin);
                        joursAbsence += Math.ceil(Math.abs(d2 - d1) / (1000 * 60 * 60 * 24)) + 1;
                    });

                    const sesDailies = (dailies || []).filter(d => d.employee_id === e.id && d.report_date.includes(searchPattern));

                    return {
                        matricule: e.matricule || 'N/A',
                        nom: e.nom,
                        poste: e.poste || 'Délégué',
                        total_visites: sesVisites.length,
                        total_produits: totalProduits, // On renvoie ce chiffre au frontend
                        detail_lieux: detailLieux,
                        jours_absence: joursAbsence,
                        dernier_rapport: sesDailies.length > 0 ? sesDailies[sesDailies.length - 1].summary : "Rien à signaler"
                    };
                });

                return res.json(auditReport);
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        }


               

// --- IMPORT MASSIF DE ZONES / SIÈGES (CSV) ---
else if (action === 'import-zones') {
    if (!req.user.permissions.can_manage_config) return res.status(403).json({ error: "Interdit" });
    
    const { zones } = req.body; // [{nom, latitude, longitude, rayon}, ...]
    
    // Insertion massive
    const { error } = await supabase.from('zones').insert(zones);
    
    if (error) {
        console.error("Erreur Import Zones:", error.message);
        throw error;
    }
    return res.json({ status: "success", count: zones.length });
}
// --- ROUTE : STATISTIQUES GLOBALES (POUR DASHBOARD & GRAPHIQUES) ---





else if (action === 'get-dashboard-stats') {

            if (!checkPerm(req, 'can_see_dashboard')) {
                return res.status(403).json({ error: "Accès interdit aux statistiques" });
            }
            
            try {
                const today = new Date().toISOString().split('T')[0];
                const currentUserId = req.user.emp_id;

                // --- 1. RÉCUPÉRATION DU PÉRIMÈTRE ---
                const { data: requester } = await supabase.from('employees')
                    .select('hierarchy_path, management_scope')
                    .eq('id', currentUserId)
                    .single();

                let query = supabase.from('employees').select('id, statut, departement, hierarchy_path');

                // --- 2. FILTRE DE SÉCURITÉ ---
                if (!checkPerm(req, 'can_see_employees')) {
                    if (req.user.role === 'MANAGER' && requester) {
                        let conditions = [];
                        conditions.push(`hierarchy_path.eq.${requester.hierarchy_path}`);
                        conditions.push(`hierarchy_path.ilike.${requester.hierarchy_path}/%`);
                        
                        if (requester.management_scope?.length > 0) {
                            const scopeList = `(${requester.management_scope.map(s => `"${s}"`).join(',')})`;
                            conditions.push(`departement.in.${scopeList}`);
                        }
                        query = query.or(conditions.join(','));
                    } else {
                        query = query.eq('id', currentUserId);
                    }
                }

                const { data: employees, error: errEmp } = await query;
                if (errEmp) throw errEmp;

                // --- 3. GESTION DES CONGÉS ---
                const allowedIds = employees.map(e => e.id);
                
                const { data: activeLeaves } = await supabase
                    .from('conges')
                    .select('employee_id')
                    .eq('statut', 'Validé')
                    .lte('date_debut', today)
                    .gte('date_fin', today)
                    .in('employee_id', allowedIds);

                const idsEnCongePlanifie = new Set((activeLeaves || []).map(l => l.employee_id));

                // --- 4. CALCUL DES STATISTIQUES ---
                const stats = {
                    total: employees.length,
                    actifs: 0,
                    sortis: 0,
                    enConge: 0,
                    depts: {}
                };

                employees.forEach(emp => {
                    const s = (emp.statut || 'Actif').toLowerCase().trim();
                    
                    if (s === 'sortie') {
                        stats.sortis++;
                    } 
                    else if (s.includes('cong') || idsEnCongePlanifie.has(emp.id)) {
                        stats.enConge++;
                    } 
                    else {
                        // ICI : "Actif", "En Poste", "Mission"... tout ça compte comme ACTIF
                        stats.actifs++;
                    }

                    const d = emp.departement || 'Non défini';
                    stats.depts[d] = (stats.depts[d] || 0) + 1;
                });

                return res.json(stats);

            } catch (err) {
                console.error("Erreur stats filtrées:", err.message);
                return res.status(500).json({ error: err.message });
            }
        }



    // ============================================================
        // ROUTE : SUPPRESSION DÉFINITIVE D'UN EMPLOYÉ
        // ============================================================
        else if (action === 'delete-employee') {
            // Vérification stricte de la permission Admin
            if (!checkPerm(req, 'can_delete_employees')) {
                return res.status(403).json({ error: "Accès refusé : Seul l'administrateur peut supprimer un profil." });
            }

            const { id, agent } = req.body;

            try {
                // 1. Récupérer l'ID de l'utilisateur lié avant de supprimer l'employé
                const { data: emp, error: fetchErr } = await supabase
                    .from('employees')
                    .select('user_associated_id, nom')
                    .eq('id', id)
                    .single();

                if (fetchErr || !emp) throw new Error("Employé introuvable.");

                // 2. Supprimer l'employé de la table 'employees'
                // Note: Si tes clés étrangères sont en "CASCADE", cela supprimera ses pointages et congés automatiquement
                const { error: delEmpErr } = await supabase.from('employees').delete().eq('id', id);
                if (delEmpErr) throw delEmpErr;

                // 3. Supprimer le compte d'accès dans 'app_users'
                if (emp.user_associated_id) {
                    await supabase.from('app_users').delete().eq('id', emp.user_associated_id);
                }

                // 4. Loguer l'action dans l'audit
                await supabase.from('logs').insert([{
                    agent: agent,
                    action: 'SUPPRESSION_EMPLOYE',
                    details: `Suppression définitive de ${emp.nom} (ID: ${id})`
                }]);

                return res.json({ status: "success" });

            } catch (err) {
                console.error("Erreur suppression:", err.message);
                return res.status(500).json({ error: err.message });
            }
        }

// ============================================================
// JOB D'ARCHIVAGE AUTOMATIQUE (Maintenance Long Terme)
// ============================================================
else if (action === 'run-archiving-job') {
    if (!checkPerm(req, 'can_manage_config')) return res.status(403).json({ error: "Interdit : Droits de maintenance requis." });
    const results = { logs: 0, visits: 0, photos_deleted: 0, employees: 0 };
    
    try {
        // --- 1. ARCHIVAGE DES LOGS (> 1 AN) ---
        // On déplace les vieux logs vers la table archives.logs
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

        // A. Copie vers archive
        const { data: oldLogs } = await supabase
            .from('logs')
            .select('*')
            .lt('created_at', oneYearAgo.toISOString());

        if (oldLogs && oldLogs.length > 0) {
            await supabase.from('logs', { schema: 'archives' }).insert(oldLogs);
            // B. Suppression de la table active
            const { count } = await supabase
                .from('logs')
                .delete({ count: 'exact' })
                .lt('created_at', oneYearAgo.toISOString());
            results.logs = count;
        }

        // --- 2. NETTOYAGE DES PHOTOS DE VISITE (> 1 AN) ---
        // Les preuves de visite (cachets) ne sont utiles que pour le paiement des primes
        // Après 1 an, on garde la ligne SQL (preuve texte) mais on supprime la photo pour sauver le stockage
        const { data: oldVisits } = await supabase
            .from('visit_reports')
            .select('id, proof_url')
            .lt('check_in_time', oneYearAgo.toISOString())
            .not('proof_url', 'is', null);

        if (oldVisits && oldVisits.length > 0) {
            const filesToDelete = [];
            const idsToClean = [];

            oldVisits.forEach(v => {
                if (v.proof_url) {
                    // Extraction du chemin du fichier depuis l'URL Supabase
                    const path = v.proof_url.split('/documents/')[1]; 
                    if (path) filesToDelete.push(path);
                }
                idsToClean.push(v.id);
            });

            if (filesToDelete.length > 0) {
                // Suppression physique des fichiers
                await supabase.storage.from('documents').remove(filesToDelete);
                // Suppression du lien dans la base (on met NULL)
                await supabase.from('visit_reports').update({ proof_url: null }).in('id', idsToClean);
                results.photos_deleted = filesToDelete.length;
            }
        }

        // --- 3. ARCHIVAGE EMPLOYÉS "SORTIE" (> 6 MOIS) ---
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

        // On cherche les employés marqués "Sortie" dont la modif date de plus de 6 mois
        // Note: Cela suppose que tu as une colonne 'updated_at' ou qu'on se base sur une logique métier
        // Ici, on va se baser sur ceux qui n'ont pas pointé depuis 6 mois ET qui sont 'Sortie'
        
        const { data: exitedEmployees } = await supabase
            .from('employees')
            .select('*')
            .eq('statut', 'Sortie'); // On filtre d'abord ceux qui sont Sortis

        // On filtre manuellement ceux partis depuis longtemps (si on n'a pas de date de sortie précise)
        // Pour être sûr, on archive ceux qui sont "Sortie"
        
        if (exitedEmployees && exitedEmployees.length > 0) {
             // A. Copie vers archives.employees
             const { error: arcErr } = await supabase.from('employees', { schema: 'archives' }).insert(exitedEmployees);
             
             if (!arcErr) {
                 const idsToDelete = exitedEmployees.map(e => e.id);
                 
                 // B. Suppression de la table active (CASCADE va nettoyer les liens si configuré, sinon attention)
                 // Pour la sécurité, on supprime d'abord l'utilisateur de l'app (app_users) si on veut bloquer l'accès
                 // Ici on supprime juste de la table employees pour alléger la liste
                 await supabase.from('employees').delete().in('id', idsToDelete);
                 results.employees = idsToDelete.length;
             }
        }

        return res.json({ status: "success", report: results });

    } catch (err) {
        console.error("Job Archivage:", err);
        return res.status(500).json({ error: err.message });
    }
}


    // Dans ton bloc "else if" central (router)
else if (action === 'list-departments') {
    const { data, error } = await supabase
        .from('departments')
        .select('*')
        .eq('is_active', true)
        .order('label', { ascending: true });

    if (error) throw error;
    return res.json(data);
}
        
        else {
            return res.json({ status: "error", message: "Action non gérée" });
        }

    } catch (err) {
        console.error(`🔥 Erreur :`, err.message);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 SERVEUR V2 SUPABASE PRÊT : Port ${PORT}`));  
































































































