import { elizaLogger } from "@elizaos/core";

/**
 * Helper function for making fetch requests with retries.
 * @param url - API endpoint URL.
 * @param options - Fetch options including method, headers, body.
 * @param retries - Number of retry attempts.
 * @param delayMs - Delay between retries in milliseconds.
 */
async function fetchWithRetries(
    url: string,
    options: RequestInit,
    retries = 3,
    delayMs = 2000
): Promise<any> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            elizaLogger.log("API Request - ", url);
            console.log('api option - - - ', options);
            const response = await fetch(url, options);
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error(`Attempt ${attempt} failed:`, error);
            if (attempt < retries) {
                console.log(`Retrying in ${delayMs} ms...`);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            } else {
                console.error("All attempts failed.");
                throw error; // Bubble up the error after retries
            }
        }
    }
}

/**
 * Fetch landing page data from the BNV backend.
 * @param backend - The backend URL.
 * @param retries - Number of retry attempts.
 * @param delayMs - Delay between retries.
 */
export async function getResponseFromBnv(
    backend: string,
    retries = 3,
    delayMs = 2000
): Promise<any> {
    const url = `${backend}/api/landing`;
    return fetchWithRetries(
        url,
        { method: "GET", headers: { "Content-Type": "application/json" } },
        retries,
        delayMs
    );
}

/**
 * Create a new ME:ID user using the BNV backend.
 * @param backend - The backend URL.
 * @param name - Name of the user to create.
 * @param retries - Number of retry attempts.
 * @param delayMs - Delay between retries.
 */
export async function createMeIdUser(
    backend: string,
    name: string,
    agentId: string,
    retries = 3,
    delayMs = 3000
): Promise<any> {
    const url = `${backend}/api/eliza/add-user`;
    const options = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: name, agentId: agentId }), // Fixed: properly sending the payload
    };

    return fetchWithRetries(url, options, retries, delayMs);
}

/**
 * Get all wearables
 * @param backend - The backend URL.
 * @param retries - Number of retry attempts.
 * @param delayMs - Delay between retries.
 * @returns
 */
export async function getWearables(
    backend: string,
    agentId: string,
    retries = 3,
    delayMs = 2000
): Promise<any> {
    const url = `${backend}/api/eliza/get-wearables`;
    const tt = await fetchWithRetries(
        url,
        {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "api-key": agentId,
            },
        },
        retries,
        delayMs
    );
    return tt;
}


export async function createNewOutfit(
    backend: String,
    outfitVariables: any,
    agentId: string,
    retries = 3,
    delayMs = 2000,
) {
    const url = `${backend}/api/eliza/update-outfit`;
    const tt = await fetchWithRetries(
        url,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "api-key": agentId,
            },
            body: JSON.stringify({ outfitVariables }),
        },
        retries,
        delayMs,
    );
    return tt;
}
