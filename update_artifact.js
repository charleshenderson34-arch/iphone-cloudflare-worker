const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Target Directories & Local Configurations
const targetDir = '/Users/stevendyke/my-aptos-project';
const yamlFile = path.join(targetDir, 'sentio.yaml');
const wranglerTomlPath = path.join(process.cwd(), 'wrangler.toml');

// CLOUDFLARE INFRASTRUCTURE TUNING
const DEPLOY_TO_CLOUDFLARE = true; 
const CLOUDFLARE_STORAGE_TYPE = 'KV'; // Options: 'KV' or 'R2'
const BUCKET_OR_NAMESPACE_NAME = 'aptos_artifacts'; 

// 1. Ensure local folder tracking structure exists
if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
    console.log(`Created target directory: ${targetDir}`);
}

// 2. Automatically provision wrangler.toml file & Cloudflare spaces
if (DEPLOY_TO_CLOUDFLARE) {
    // A. Verify baseline wrangler.toml exists so Wrangler can write configs to it
    if (!fs.existsSync(wranglerTomlPath)) {
        const defaultToml = `name = "aptos-artifact-pipeline"\ncompatibility_date = "${new Date().toISOString().split('T')[0]}"\n\n`;
        fs.writeFileSync(wranglerTomlPath, defaultToml, 'utf8');
        console.log(`Initialized a missing wrangler.toml configuration matrix.`);
    }

    // B. Handle structural initialization and mapping injections
    try {
        const currentTomlContent = fs.readFileSync(wranglerTomlPath, 'utf8');
        
        if (CLOUDFLARE_STORAGE_TYPE === 'KV') {
            // Check if binding registry statement is already injected
            if (!currentTomlContent.includes(`binding = "${BUCKET_OR_NAMESPACE_NAME}"`)) {
                console.log(`Cloudflare KV Namespace "${BUCKET_OR_NAMESPACE_NAME}" not found in config. Provisioning...`);
                // --update-config automatically creates the remote KV resource and injects the [[kv_namespaces]] block
                execSync(`npx wrangler kv namespace create ${BUCKET_OR_NAMESPACE_NAME} --update-config`, { stdio: 'inherit' });
            }
        } else if (CLOUDFLARE_STORAGE_TYPE === 'R2') {
            if (!currentTomlContent.includes(`bucket_name = "${BUCKET_OR_NAMESPACE_NAME}"`)) {
                console.log(`Cloudflare R2 Bucket "${BUCKET_OR_NAMESPACE_NAME}" not found in config. Provisioning...`);
                // Setup target remote space bucket layout
                execSync(`npx wrangler r2 bucket create ${BUCKET_OR_NAMESPACE_NAME}`, { stdio: 'inherit' });
                
                // Append R2 TOML block structure since r2 create does not have an auto-update flag
                const r2TomlBlock = `\n[[r2_buckets]]\nbinding = "${BUCKET_OR_NAMESPACE_NAME.toUpperCase().replace(/-/g, '_')}"\nbucket_name = "${BUCKET_OR_NAMESPACE_NAME}"\n`;
                fs.appendFileSync(wranglerTomlPath, r2TomlBlock, 'utf8');
                console.log(`Successfully mapped R2 configurations inside your wrangler.toml file.`);
            }
        }
    } catch (configError) {
        console.error('Warning during Cloudflare infrastructure initialization phase:', configError.message);
        console.log('Continuing execution assuming resources might already exist remotely...');
    }
}

// 3. Compile Solidity contracts with extra outputs (.abi, .bin)
console.log('Compiling contracts via Foundry Forge...');
try {
    execSync('forge build --force --extra-output abi bin', { stdio: 'inherit' });
    console.log('Compilation successful. Moving artifacts...');
} catch (error) {
    console.error('Compilation failed! Aborting process.');
    process.exit(1);
}

// 4. Helper function to recursively find files matching extensions
function findFiles(dir, extensions, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    
    files.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) {
            if (file !== 'node_modules' && !file.startsWith('.')) {
                findFiles(filePath, extensions, fileList);
            }
        } else {
            const ext = path.extname(file);
            if (extensions.includes(ext)) {
                fileList.push(filePath);
            }
        }
    });
    
    return fileList;
}

// 5. Function to upload an artifact to Cloudflare using Wrangler CLI
function uploadToCloudflare(filePath, filename) {
    try {
        if (CLOUDFLARE_STORAGE_TYPE === 'KV') {
            console.log(`[Cloudflare KV] Uploading ${filename}...`);
            execSync(`npx wrangler kv key put "${filename}" --file="${filePath}" --binding=${BUCKET_OR_NAMESPACE_NAME}`, { stdio: 'inherit' });
        } else if (CLOUDFLARE_STORAGE_TYPE === 'R2') {
            console.log(`[Cloudflare R2] Uploading ${filename}...`);
            execSync(`npx wrangler r2 object put "${BUCKET_OR_NAMESPACE_NAME}/${filename}" --file="${filePath}"`, { stdio: 'inherit' });
        }
        console.log(`Successfully uploaded ${filename} to Cloudflare.`);
    } catch (error) {
        console.error(`Failed to upload ${filename} to Cloudflare. Verify \`npx wrangler login\` status.`);
    }
}

// 6. Copy files, update config.yaml, and upload to Cloudflare
const targetExtensions = ['.abi', '.sol', '.bin'];
const forgeOutDir = path.join(process.cwd(), 'out'); 
const foundFiles = findFiles(forgeOutDir, targetExtensions);

if (foundFiles.length === 0) {
    console.log('No matching compiled artifacts found in the build output directory.');
} else {
    foundFiles.forEach(filePath => {
        const filename = path.basename(filePath);
        const destination = path.join(targetDir, filename);

        // Copy locally
        fs.copyFileSync(filePath, destination);
        
        // Append local YAML log entry
        const yamlEntry = `  - artifact: ${filename}\n`;
        fs.appendFileSync(yamlFile, yamlEntry);
        console.log(`Copied and logged locally: ${filename}`);

        // Push to Cloudflare if enabled
        if (DEPLOY_TO_CLOUDFLARE) {
            uploadToCloudflare(destination, filename);
        }
    });
    
    console.log('\nAll contract artifacts successfully compiled, migrated locally, infrastructure mapped, and synced.');
}
