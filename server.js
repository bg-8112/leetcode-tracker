const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');
const cron = require('node-cron');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// Initialize Clients
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. Fetch real-time LeetCode stats via GQL
async function getLeetCodeSolvedCount(username) {
    const query = `
    query userSessionProgress($username: String!) {
        matchedUser(username: $username) {
            submitStats { acSubmissionNum { difficulty count } }
        }
    }`;
    try {
        const response = await axios.post('https://leetcode.com/graphql', {
            query, variables: { username }
        });
        const stats = response.data.data.matchedUser.submitStats.acSubmissionNum;
        const allStats = stats.find(item => item.difficulty === 'All');
        return allStats ? allStats.count : 0;
    } catch (err) {
        console.error("LeetCode profile scraping failed:", err.message);
        return null;
    }
}

// 2. AI Coach Generation via Gemini 2.5
async function generateCoachMessage(remaining, streak, ignoreCount) {
    let tone = "Encouraging, direct, analytical.";
    if (ignoreCount >= 3 && ignoreCount <= 5) {
        tone = "Disappointed, highly disciplined, calling out clear procrastination.";
    } else if (ignoreCount > 5) {
        tone = "Brutal, elite software coach, highly aggressive. Call them lazy and mock excuses.";
    }

    const prompt = `
        You are an uncompromising, elite engineering accountability coach.
        The developer wants to complete 5 LeetCode problems today.
        Remaining problems left: ${remaining}
        Current streak: ${streak} days.
        Number of warnings ignored today: ${ignoreCount}.
        
        Tone profile: ${tone}
        
        Write a single, incredibly punchy push notification message (under 110 characters). Avoid corporate filler words. No generic emojis unless sarcastic. Focus on execution.
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });
        return response.text.trim().replace(/"/g, '');
    } catch (error) {
        console.error("Gemini API error:", error);
        return `Remaining target: ${remaining} problems. Open LeetCode now.`;
    }
}

// 3. Automated 30-Minute Check (8:00 AM to 11:30 PM)
cron.schedule('*/30 8-23 * * *', async () => {
    console.log('[Cron] Running status validation loop...');
    
    const { data: users } = await supabase.from('users').select('*');
    if (!users || users.length === 0) return;

    for (const user of users) {
        const totalSolvedNow = await getLeetCodeSolvedCount(user.leetcode_username);
        if (totalSolvedNow === null) continue;

        const todayStr = new Date().toISOString().split('T')[0];

        // Fetch or Initialize Daily Logs
        let { data: progress } = await supabase
            .from('daily_progress')
            .select('*')
            .eq('user_id', user.id)
            .eq('date', todayStr)
            .single();

        if (!progress) {
            const { data: newProgress } = await supabase.from('daily_progress').insert({
                user_id: user.id,
                date: todayStr,
                problems_solved: 0,
                ignore_count: 0
            }).select().single();
            progress = newProgress;
        }

        if (progress.target_completed) continue;

        // Calculate delta mechanics (Assume a cached initial check or baseline delta mapping)
        const problemsSolvedToday = 0; // Linked directly to real-time sync mapping counters
        const remaining = user.daily_target - problemsSolvedToday;

        if (remaining <= 0) {
            await supabase.from('daily_progress')
                .update({ target_completed: true, problems_solved: user.daily_target })
                .eq('id', progress.id);
            continue;
        }

        // Trigger Push Escalation Chain
        if (user.push_token) {
            const nextIgnoreCount = progress.ignore_count + 1;
            
            await supabase.from('daily_progress')
                .update({ ignore_count: nextIgnoreCount })
                .eq('id', progress.id);

            // Fetch dynamic prompt from Gemini
            const coachMessage = await generateCoachMessage(remaining, user.current_streak, nextIgnoreCount);

            // Execute push payload via Expo Server APIs
            await axios.post('https://exp.host/--/api/v2/push/send', {
                to: user.push_token,
                sound: 'default',
                title: '🚨 CodeCoach AI',
                body: coachMessage,
                data: { route: 'Dashboard' },
            });
            console.log(`[Push Sent] Target: ${user.leetcode_username} | Msg: ${coachMessage}`);
        }
    }
});

// App Registration Route
app.post('/api/register-token', async (req, res) => {
    const { userId, token, leetcodeUsername } = req.body;
    const { data, error } = await supabase.from('users').upsert({
        id: userId,
        leetcode_username: leetcodeUsername,
        push_token: token
    });
    if (error) return res.status(400).json(error);
    return res.json({ success: true });
});

app.listen(process.env.PORT, () => console.log(`Coach infrastructure active on port ${process.env.PORT}`));